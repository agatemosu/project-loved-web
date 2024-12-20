import { Router } from 'express';
import type { GameMode } from 'loved-bridge/beatmaps/gameMode';
import { RankedStatus } from 'loved-bridge/beatmaps/rankedStatus';
import type {
  Beatmapset,
  Consent,
  ConsentBeatmapset,
  Review,
  Submission,
  User,
} from 'loved-bridge/tables';
import { ConsentValue, LogType, Role } from 'loved-bridge/tables';
import { deleteCache } from '../cache.js';
import type { MysqlConnectionType } from '../db.js';
import db from '../db.js';
import { asyncHandler } from '../express-helpers.js';
import { currentUserRoles } from '../guards.js';
import { pick } from '../helpers.js';
import { dbLog, dbLogBeatmapset, dbLogReview, dbLogSubmission, dbLogUser } from '../log.js';
import {
  isGameMode,
  isGameModeArray,
  isInteger,
  isMapperConsent,
  isMapperConsentBeatmapsetArray,
} from '../type-guards.js';

const anyoneRouter = Router();
export default anyoneRouter;

anyoneRouter.post(
  '/mapper-consent',
  asyncHandler(async (req, res) => {
    if (!isMapperConsent(req.body.consent)) {
      return res.status(422).json({ error: 'Invalid consent' });
    }

    if (req.body.consent.consent === ConsentValue.unreachable) {
      return res
        .status(422)
        .json({ error: 'The "unreachable" consent option is no longer supported' });
    }

    if (!isMapperConsentBeatmapsetArray(req.body.consentBeatmapsets)) {
      return res.status(422).json({ error: 'Invalid mapper consent beatmapsets' });
    }

    const user = await res.typedLocals.osu.createOrRefreshUser(req.body.consent.user_id);

    if (user == null) {
      return res.status(404).json({ error: 'User not found' });
    }

    const hasRole = currentUserRoles(req, res);

    if (user.id !== res.typedLocals.user.id && !hasRole(Role.captain)) {
      return res.status(403).json({
        error: 'Must be a captain to update consents of other users',
      });
    }

    const currentConsent = await db.queryOne<Consent>(
      'SELECT * FROM mapper_consents WHERE user_id = ?',
      [user.id],
    );
    const currentConsentBeatmapsets = await db.query<ConsentBeatmapset>(
      'SELECT * FROM mapper_consent_beatmapsets WHERE user_id = ?',
      [user.id],
    );

    const currentConsentBeatmapsetIds = currentConsentBeatmapsets.map((c) => c.beatmapset_id);
    const newConsentBeatmapsetIds = req.body.consentBeatmapsets.map((c) => c.beatmapset_id);
    const beatmapsetIdsAdded = newConsentBeatmapsetIds.filter(
      (id) => !currentConsentBeatmapsetIds.includes(id),
    );
    const beatmapsetIdsRemoved = currentConsentBeatmapsetIds.filter(
      (id) => !newConsentBeatmapsetIds.includes(id),
    );

    for (const beatmapsetId of beatmapsetIdsAdded) {
      const beatmapset = await res.typedLocals.osu.createOrRefreshBeatmapset(beatmapsetId);

      if (beatmapset == null) {
        return res.status(404).json({ error: `Beatmapset #${beatmapsetId} not found` });
      }
    }

    const logActor = dbLogUser(res.typedLocals.user);
    const logUser = dbLogUser(user);

    // For easier typing in transaction
    const newConsent = req.body.consent;
    const newConsentBeatmapsets = req.body.consentBeatmapsets;

    await db.transact(async (connection) => {
      const dbFields = {
        consent: newConsent.consent,
        consent_reason: newConsent.consent_reason,
        updated_at: new Date(),
        updater_id: res.typedLocals.user.id,
      };
      const dbFieldsWithPK = {
        ...dbFields,
        user_id: newConsent.user_id,
      };

      if (currentConsent == null) {
        await connection.query('INSERT INTO mapper_consents SET ?', [dbFieldsWithPK]);
        await dbLog(
          LogType.mapperConsentCreated,
          {
            actor: logActor,
            consent: newConsent.consent,
            reason: newConsent.consent_reason,
            user: logUser,
          },
          connection,
        );
      } else if (
        currentConsent.consent !== newConsent.consent ||
        currentConsent.consent_reason !== newConsent.consent_reason
      ) {
        await connection.query('UPDATE mapper_consents SET ? WHERE user_id = ?', [
          dbFields,
          dbFieldsWithPK.user_id,
        ]);
        await dbLog(
          LogType.mapperConsentUpdated,
          {
            actor: logActor,
            from: {
              consent: currentConsent.consent,
              reason: currentConsent.consent_reason,
            },
            to: {
              consent: newConsent.consent,
              reason: newConsent.consent_reason,
            },
            user: logUser,
          },
          connection,
        );
      }

      if (beatmapsetIdsRemoved.length > 0) {
        await connection.query(
          `
            DELETE FROM mapper_consent_beatmapsets
            WHERE beatmapset_id IN (?)
              AND user_id = ?
          `,
          [beatmapsetIdsRemoved, newConsent.user_id],
        );
      }
      for (const beatmapsetId of beatmapsetIdsRemoved) {
        const beatmapset = await connection.queryOne<Beatmapset>(
          'SELECT * FROM beatmapsets WHERE id = ?',
          [beatmapsetId],
        );

        if (beatmapset == null) {
          throw 'Missing beatmapset for logging consent beatmapset delete';
        }

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const consentBeatmapset = currentConsentBeatmapsets.find(
          (consent) => consent.beatmapset_id === beatmapsetId,
        )!;

        await dbLog(
          LogType.mapperConsentBeatmapsetDeleted,
          {
            actor: logActor,
            beatmapset: dbLogBeatmapset(beatmapset),
            consent: consentBeatmapset.consent,
            reason: consentBeatmapset.consent_reason,
            user: logUser,
          },
          connection,
        );
      }

      for (const consentBeatmapset of newConsentBeatmapsets) {
        const beatmapset = await connection.queryOne<Beatmapset>(
          'SELECT * FROM beatmapsets WHERE id = ?',
          [consentBeatmapset.beatmapset_id],
        );

        if (beatmapset == null) {
          throw 'Missing beatmapset for logging consent beatmapset create or update';
        }

        const currentConsentBeatmapset = currentConsentBeatmapsets.find(
          (c) => c.beatmapset_id === consentBeatmapset.beatmapset_id,
        );
        const dbFields = pick(consentBeatmapset, ['consent', 'consent_reason']);
        const dbFieldsWithPK = {
          ...dbFields,
          beatmapset_id: consentBeatmapset.beatmapset_id,
          user_id: newConsent.user_id,
        };
        const logBeatmapset = dbLogBeatmapset(beatmapset);

        if (currentConsentBeatmapset == null) {
          await connection.query('INSERT INTO mapper_consent_beatmapsets SET ?', [dbFieldsWithPK]);
          await dbLog(
            LogType.mapperConsentBeatmapsetCreated,
            {
              actor: logActor,
              beatmapset: logBeatmapset,
              consent: consentBeatmapset.consent,
              reason: consentBeatmapset.consent_reason,
              user: logUser,
            },
            connection,
          );
        } else if (
          currentConsentBeatmapset.consent !== consentBeatmapset.consent ||
          currentConsentBeatmapset.consent_reason !== consentBeatmapset.consent_reason
        ) {
          await connection.query(
            `
              UPDATE mapper_consent_beatmapsets
              SET ?
              WHERE beatmapset_id = ?
              AND user_id = ?
            `,
            [dbFields, dbFieldsWithPK.beatmapset_id, dbFieldsWithPK.user_id],
          );
          await dbLog(
            LogType.mapperConsentBeatmapsetUpdated,
            {
              actor: logActor,
              beatmapset: logBeatmapset,
              from: {
                consent: currentConsentBeatmapset.consent,
                reason: currentConsentBeatmapset.consent_reason,
              },
              to: {
                consent: consentBeatmapset.consent,
                reason: consentBeatmapset.consent_reason,
              },
              user: logUser,
            },
            connection,
          );
        }
      }
    });

    deleteCache('mapper-consents');
    deleteCache('submissions:mapper-consent-beatmapsets');
    deleteCache('submissions:mapper-consents');

    const consent: Consent & {
      beatmapset_consents?: (ConsentBeatmapset & { beatmapset: Beatmapset })[];
      mapper: User;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    } = (await db.queryOneWithGroups<Consent & { mapper: User }>(
      `
        SELECT mapper_consents.*, mappers:mapper
        FROM mapper_consents
        INNER JOIN users AS mappers
          ON mapper_consents.user_id = mappers.id
        WHERE mapper_consents.user_id = ?
      `,
      [newConsent.user_id],
    ))!;
    consent.beatmapset_consents = await db.queryWithGroups<
      ConsentBeatmapset & { beatmapset: Beatmapset }
    >(
      `
        SELECT mapper_consent_beatmapsets.*, beatmapsets:beatmapset
        FROM mapper_consent_beatmapsets
        INNER JOIN beatmapsets
          ON mapper_consent_beatmapsets.beatmapset_id = beatmapsets.id
        WHERE mapper_consent_beatmapsets.user_id = ?
      `,
      [newConsent.user_id],
    );

    res.json(consent);
  }),
);

anyoneRouter.post(
  '/review',
  asyncHandler(async (req, res) => {
    if (!isInteger(req.body.beatmapsetId)) {
      return res.status(422).json({ error: 'Invalid beatmapset ID' });
    }

    if (!isGameMode(req.body.gameMode)) {
      return res.status(422).json({ error: 'Invalid game mode' });
    }

    if (typeof req.body.reason !== 'string') {
      return res.status(422).json({ error: 'Invalid reason' });
    }

    if (!isInteger(req.body.score) || req.body.score < -4 || req.body.score > 3) {
      return res.status(422).json({ error: 'Invalid score' });
    }

    const hasRole = currentUserRoles(req, res);

    if ([-4, 0].includes(req.body.score) && !hasRole(Role.captain, req.body.gameMode)) {
      return res
        .status(403)
        .send({ error: `Must be a captain to use review score ${req.body.score}` });
    }

    const existingReview = await db.queryOne<Review>(
      `
        SELECT *
        FROM reviews
        WHERE beatmapset_id = ?
          AND reviewer_id = ?
          AND game_mode = ?
      `,
      [req.body.beatmapsetId, res.typedLocals.user.id, req.body.gameMode],
    );

    // "Support" and "Rejection" are no longer selectable, unless the review was already set to the same score
    if (
      (req.body.score === -2 || req.body.score === 2) &&
      req.body.score !== existingReview?.score
    ) {
      return res.status(422).json({ error: 'Invalid score' });
    }

    const beatmapset = await res.typedLocals.osu.createOrRefreshBeatmapset(
      req.body.beatmapsetId,
      true,
    );

    if (beatmapset == null) {
      return res.status(422).json({ error: 'Invalid beatmapset ID' });
    }

    // TODO: This should allow cases where the set is Loved but at least one
    //       difficulty in the requested mode is Pending/WIP/Graveyard
    if (beatmapset.ranked_status > RankedStatus.pending) {
      return res.status(422).json({ error: 'Beatmapset is already Ranked/Loved/Qualified' });
    }

    if (!beatmapset.game_modes.has(req.body.gameMode)) {
      return res.status(422).json({
        error: `Beatmapset has no beatmaps in game mode ${req.body.gameMode}`,
      });
    }

    const deleteExistingSubmission = async (connection: MysqlConnectionType) => {
      const submissionToDelete = await connection.queryOne<Submission>(
        `
          SELECT *
          FROM submissions
          WHERE beatmapset_id = ?
            AND game_mode = ?
            AND reason IS NULL
            AND submitter_id = ?
        `,
        [req.body.beatmapsetId, req.body.gameMode, res.typedLocals.user.id],
      );

      if (submissionToDelete != null) {
        await connection.query('DELETE FROM submissions WHERE id = ?', [submissionToDelete.id]);
        await dbLog(
          LogType.submissionDeleted,
          {
            actor: dbLogUser(res.typedLocals.user),
            beatmapset: dbLogBeatmapset(beatmapset),
            submission: dbLogSubmission(submissionToDelete),
            user: dbLogUser(res.typedLocals.user),
          },
          connection,
        );
      }
    };

    const captainRole = res.typedLocals.user.roles.find(
      (role) => role.game_mode === req.body.gameMode && role.role_id === Role.captain,
    );
    const activeCaptain = captainRole == null ? null : !captainRole.alumni;

    if (existingReview != null) {
      return await db.transact(async (connection) => {
        await connection.query('UPDATE reviews SET ? WHERE id = ?', [
          {
            reason: req.body.reason,
            reviewed_at: new Date(),
            score: req.body.score,
          },
          existingReview.id,
        ]);
        const newReview = await connection.queryOne<Review>('SELECT * FROM reviews WHERE id = ?', [
          existingReview.id,
        ]);

        if (newReview == null) {
          throw 'Missing review immediately after update';
        }

        if (existingReview.reason !== req.body.reason || existingReview.score !== req.body.score) {
          await dbLog(
            LogType.reviewUpdated,
            {
              beatmapset: dbLogBeatmapset(beatmapset),
              from: dbLogReview(existingReview),
              to: dbLogReview(newReview),
              user: dbLogUser(res.typedLocals.user),
            },
            connection,
          );
        }

        await deleteExistingSubmission(connection);

        deleteCache(`submissions:${req.body.gameMode}:reviews`);

        res.json({
          ...newReview,
          active_captain: activeCaptain,
        });
      });
    }

    await db.transact(async (connection) => {
      const { insertId } = await connection.query('INSERT INTO reviews SET ?', [
        {
          beatmapset_id: req.body.beatmapsetId,
          game_mode: req.body.gameMode,
          reason: req.body.reason,
          reviewed_at: new Date(),
          reviewer_id: res.typedLocals.user.id,
          score: req.body.score,
        },
      ]);
      const newReview = await connection.queryOne<Review>('SELECT * FROM reviews WHERE id = ?', [
        insertId,
      ]);

      if (newReview == null) {
        throw 'Missing review immediately after create';
      }

      await dbLog(
        LogType.reviewCreated,
        {
          beatmapset: dbLogBeatmapset(beatmapset),
          review: dbLogReview(newReview),
          user: dbLogUser(res.typedLocals.user),
        },
        connection,
      );
      await deleteExistingSubmission(connection);

      deleteCache(`submissions:${req.body.gameMode}:reviews`);

      res.json({
        ...newReview,
        active_captain: activeCaptain,
      });
    });
  }),
);

anyoneRouter.delete(
  '/review',
  asyncHandler(async (req, res) => {
    const reviewId = parseInt(req.query.reviewId ?? '', 10);

    if (isNaN(reviewId)) {
      return res.status(422).json({ error: 'Invalid review ID' });
    }

    const review = await db.queryOne<Review>(
      `
        SELECT *
        FROM reviews
        WHERE id = ?
      `,
      [reviewId],
    );

    if (review == null) {
      return res.status(404).json({ error: 'Review not found' });
    }

    if (review.reviewer_id !== res.typedLocals.user.id) {
      return res.status(403).json({ error: "This isn't your review" });
    }

    const beatmapset = await db.queryOne<Beatmapset>('SELECT * FROM beatmapsets WHERE id = ?', [
      review.beatmapset_id,
    ]);

    if (beatmapset == null) {
      throw 'Missing beatmapset attached to review';
    }

    await db.transact(async (connection) => {
      await connection.query('DELETE FROM reviews WHERE id = ?', [review.id]);
      await dbLog(
        LogType.reviewDeleted,
        {
          actor: dbLogUser(res.typedLocals.user),
          beatmapset: dbLogBeatmapset(beatmapset),
          review: dbLogReview(review),
          user: dbLogUser(res.typedLocals.user),
        },
        connection,
      );
    });

    deleteCache(`submissions:${review.game_mode}:reviews`);

    res.status(204).send();
  }),
);

anyoneRouter.post(
  '/review-many',
  asyncHandler(async (req, res) => {
    if (!isInteger(req.body.beatmapsetId)) {
      return res.status(422).json({ error: 'Invalid beatmapset ID' });
    }

    if (!isGameModeArray(req.body.gameModes)) {
      return res.status(422).json({ error: 'Invalid game modes' });
    }

    if (req.body.gameModes.length === 0) {
      return res.status(422).json({ error: 'No game modes selected' });
    }

    if (typeof req.body.reason !== 'string') {
      return res.status(422).json({ error: 'Invalid reason' });
    }

    if (req.body.score !== 1 && req.body.score !== 3) {
      return res.status(422).json({ error: 'Invalid score' });
    }

    const beatmapset = await res.typedLocals.osu.createOrRefreshBeatmapset(req.body.beatmapsetId);

    if (beatmapset == null) {
      return res.status(422).json({ error: 'Invalid beatmapset ID' });
    }

    // TODO: This should allow cases where the set is Loved but at least one
    //       difficulty in each requested mode is Pending/WIP/Graveyard
    if (beatmapset.ranked_status > RankedStatus.pending) {
      return res.status(422).json({ error: 'Beatmapset is already Ranked/Loved/Qualified' });
    }

    const missingGameModes = new Set(req.body.gameModes);

    for (const gameMode of beatmapset.game_modes) {
      missingGameModes.delete(gameMode);
    }

    if (missingGameModes.size > 0) {
      return res.status(422).json({
        error: `Beatmapset has no beatmaps in game mode ${[...missingGameModes].join(', ')}`,
      });
    }

    const submissionsToDelete = await db.query<Submission>(
      `
        SELECT *
        FROM submissions
        WHERE beatmapset_id = ?
          AND game_mode IN (?)
          AND reason IS NULL
          AND submitter_id = ?
      `,
      [beatmapset.id, req.body.gameModes, res.typedLocals.user.id],
    );
    const now = new Date();
    const logActorAndUser = dbLogUser(res.typedLocals.user);
    const logBeatmapset = dbLogBeatmapset(beatmapset);

    await db.transact(async (connection) => {
      if (submissionsToDelete.length > 0) {
        await connection.query('DELETE FROM submissions WHERE id IN (?)', [
          submissionsToDelete.map((submission) => submission.id),
        ]);

        for (const submission of submissionsToDelete) {
          await dbLog(
            LogType.submissionDeleted,
            {
              actor: logActorAndUser,
              beatmapset: logBeatmapset,
              submission: dbLogSubmission(submission),
              user: logActorAndUser,
            },
            connection,
          );
        }
      }

      for (const gameMode of req.body.gameModes as GameMode[]) {
        const existingReview = await connection.queryOne<Review>(
          `
            SELECT *
            FROM reviews
            WHERE beatmapset_id = ?
              AND game_mode = ?
              AND reviewer_id = ?
          `,
          [beatmapset.id, gameMode, res.typedLocals.user.id],
        );

        if (existingReview != null) {
          await connection.query('UPDATE reviews SET ? WHERE id = ?', [
            {
              reason: req.body.reason,
              reviewed_at: now,
              score: req.body.score,
            },
            existingReview.id,
          ]);
          const newReview = await connection.queryOne<Review>(
            'SELECT * FROM reviews WHERE id = ?',
            [existingReview.id],
          );

          if (newReview == null) {
            throw 'Missing review immediately after update';
          }

          if (
            existingReview.reason !== req.body.reason ||
            existingReview.score !== req.body.score
          ) {
            await dbLog(
              LogType.reviewUpdated,
              {
                beatmapset: logBeatmapset,
                from: dbLogReview(existingReview),
                to: dbLogReview(newReview),
                user: logActorAndUser,
              },
              connection,
            );
          }
        } else {
          const { insertId } = await connection.query('INSERT INTO reviews SET ?', [
            {
              beatmapset_id: beatmapset.id,
              game_mode: gameMode,
              reason: req.body.reason,
              reviewed_at: now,
              reviewer_id: res.typedLocals.user.id,
              score: req.body.score,
            },
          ]);
          const newReview = await connection.queryOne<Review>(
            'SELECT * FROM reviews WHERE id = ?',
            [insertId],
          );

          if (newReview == null) {
            throw 'Missing review immediately after create';
          }

          await dbLog(
            LogType.reviewCreated,
            {
              beatmapset: logBeatmapset,
              review: dbLogReview(newReview),
              user: logActorAndUser,
            },
            connection,
          );
        }

        deleteCache(`submissions:${gameMode}:reviews`);
      }
    });

    res.status(204).send();
  }),
);
