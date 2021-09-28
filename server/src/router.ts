import { Router } from 'express';
import db from './db';
import { asyncHandler } from './express-helpers';
import { isCaptain, isGod, isModerator, isNewsAuthor, roles as authRoles } from './guards';
import { getParams, groupBy } from './helpers';
import { systemLog } from './log';
import { settings, updateSettings, accessSetting } from './settings';
import { isAssigneeType, isGameMode, isNumberArray, isRecord, isStringArray } from './type-guards';

const router = Router();
export default router;

// TODO: rethink guards

//#region captain
router.post(
  '/review',
  asyncHandler(async (req, res) => {
    if (typeof req.body.beatmapsetId !== 'number') {
      return res.status(422).json({ error: 'Invalid beatmapset ID' });
    }

    if (typeof req.body.gameMode !== 'number' || req.body.gameMode < 0 || req.body.gameMode > 3) {
      return res.status(422).json({ error: 'Invalid game mode' });
    }

    if (typeof req.body.reason !== 'string') {
      return res.status(422).json({ error: 'Invalid reason' });
    }

    if (
      typeof req.body.score !== 'number' ||
      req.body.score === 0 ||
      req.body.score < -4 ||
      req.body.score > 3
    ) {
      return res.status(422).json({ error: 'Invalid score' });
    }

    const roles = authRoles(req, res);

    if (!roles.gameModes[req.body.gameMode]) {
      return res.status(403).send();
    }

    // TODO: Not dumb workaround for God role
    if (req.body.score >= -3 && !res.typedLocals.user.roles.captain) {
      return res.status(403).send();
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

    if (existingReview != null) {
      await db.query('UPDATE reviews SET ? WHERE id = ?', [
        {
          reason: req.body.reason,
          reviewed_at: new Date(),
          score: req.body.score,
        },
        existingReview.id,
      ]);

      return res.json(
        await db.queryOne<Review>('SELECT * FROM reviews WHERE id = ?', [existingReview.id]),
      );
    }

    const beatmapset = await res.typedLocals.osu.createOrRefreshBeatmapset(req.body.beatmapsetId);

    if (beatmapset == null) {
      return res.status(422).json({ error: 'Invalid beatmapset ID' });
    }

    if (!beatmapset.game_modes.has(req.body.gameMode)) {
      return res.status(422).json({
        error: `Beatmapset has no beatmaps in game mode ${req.body.gameMode}`,
      });
    }

    const { insertId } = await db.query('INSERT INTO reviews SET ?', [
      {
        beatmapset_id: req.body.beatmapsetId,
        game_mode: req.body.gameMode,
        reason: req.body.reason,
        reviewed_at: new Date(),
        reviewer_id: res.typedLocals.user.id,
        score: req.body.score,
      },
    ]);

    res.json(await db.queryOne<Review>('SELECT * FROM reviews WHERE id = ?', [insertId]));
  }),
);

router.delete(
  '/review',
  isCaptain,
  asyncHandler(async (req, res) => {
    const review = await db.queryOne<Pick<Review, 'reviewer_id'>>(
      `
        SELECT reviewer_id
        FROM reviews
        WHERE id = ?
      `,
      [req.query.reviewId],
    );

    if (review == null) {
      return res.status(404).json({ error: 'Review not found' });
    }

    if (review.reviewer_id !== res.typedLocals.user.id) {
      return res.status(403).json({ error: "This isn't your review" });
    }

    await db.query('DELETE FROM reviews WHERE id = ?', [req.query.reviewId]);

    res.status(204).send();
  }),
);

router.get(
  '/rounds',
  asyncHandler(async (_, res) => {
    const rounds = await db.query<Round & { nomination_count: number }>(`
      SELECT rounds.*, IFNULL(nomination_counts.count, 0) AS nomination_count
      FROM rounds
      LEFT JOIN (
        SELECT COUNT(*) AS count, round_id
        FROM nominations
        GROUP BY round_id
      ) AS nomination_counts
        ON rounds.id = nomination_counts.round_id
      ORDER BY rounds.id ASC
    `);

    res.json({
      complete_rounds: rounds.filter((round) => round.done).reverse(),
      incomplete_rounds: rounds.filter((round) => !round.done),
    });
  }),
);

router.get(
  '/nominations',
  asyncHandler(async (req, res) => {
    const round: (Round & { game_modes?: Record<GameMode, RoundGameMode> }) | null =
      await db.queryOne<Round>(
        `
          SELECT *
          FROM rounds
          WHERE id = ?
        `,
        [req.query.roundId],
      );

    if (round == null) {
      return res.status(404).send();
    }

    const assigneesByNominationId = groupBy<
      Nomination['id'],
      {
        assignee: User;
        assignee_type: NominationAssignee['type'];
        nomination_id: Nomination['id'];
      }
    >(
      await db.queryWithGroups<{
        assignee: User;
        assignee_type: NominationAssignee['type'];
        nomination_id: Nomination['id'];
      }>(
        `
          SELECT users:assignee, nomination_assignees.type AS assignee_type, nominations.id AS nomination_id
          FROM nominations
          INNER JOIN nomination_assignees
            ON nominations.id = nomination_assignees.nomination_id
          INNER JOIN users
            ON nomination_assignees.assignee_id = users.id
          WHERE nominations.round_id = ?
        `,
        [req.query.roundId],
      ),
      'nomination_id',
    );
    const includesByNominationId = groupBy<
      Nomination['id'],
      {
        beatmap: (Beatmap & { excluded: boolean }) | null;
        creator: User | null;
        nomination_id: Nomination['id'];
      }
    >(
      await db.queryWithGroups<{
        beatmap: (Beatmap & { excluded: boolean }) | null;
        creator: User | null;
        nomination_id: Nomination['id'];
      }>(
        `
          SELECT nominations.id AS nomination_id, creators:creator, beatmaps:beatmap,
            nomination_excluded_beatmaps.beatmap_id IS NOT NULL AS 'beatmap:excluded'
          FROM nominations
          LEFT JOIN beatmapset_creators
            ON nominations.beatmapset_id = beatmapset_creators.beatmapset_id
              AND nominations.game_mode = beatmapset_creators.game_mode
          LEFT JOIN users AS creators
            ON beatmapset_creators.creator_id = creators.id
          LEFT JOIN beatmaps
            ON nominations.beatmapset_id = beatmaps.beatmapset_id
              AND nominations.game_mode = beatmaps.game_mode
          LEFT JOIN nomination_excluded_beatmaps
            ON nominations.id = nomination_excluded_beatmaps.nomination_id
              AND beatmaps.id = nomination_excluded_beatmaps.beatmap_id
          WHERE nominations.round_id = ?
        `,
        [req.query.roundId],
      ),
      'nomination_id',
    );
    const nominatorsByNominationId = groupBy<Nomination['id'], User>(
      await db.queryWithGroups<{ nomination_id: Nomination['id']; nominator: User }>(
        `
          SELECT users:nominator, nominations.id AS nomination_id
          FROM nominations
          INNER JOIN nomination_nominators
            ON nominations.id = nomination_nominators.nomination_id
          INNER JOIN users
            ON nomination_nominators.nominator_id = users.id
          WHERE nominations.round_id = ?
        `,
        [req.query.roundId],
      ),
      'nomination_id',
      'nominator',
    );
    const nominations: (Nomination & {
      beatmaps?: (Beatmap & { excluded: boolean })[];
      beatmapset: Beatmapset;
      beatmapset_creators?: User[];
      description_author: User | null;
      metadata_assignees?: User[];
      moderator_assignees?: User[];
      nominators?: User[];
      poll: Poll | null;
    })[] = await db.queryWithGroups<
      Nomination & {
        beatmapset: Beatmapset;
        description_author: User | null;
        poll: Poll | null;
      }
    >(
      `
        SELECT nominations.*, beatmapsets:beatmapset, description_authors:description_author,
          polls:poll
        FROM nominations
        INNER JOIN beatmapsets
          ON nominations.beatmapset_id = beatmapsets.id
        LEFT JOIN users AS description_authors
          ON nominations.description_author_id = description_authors.id
        LEFT JOIN polls
          ON nominations.round_id = polls.round_id
            AND nominations.game_mode = polls.game_mode
            AND nominations.beatmapset_id = polls.beatmapset_id
        WHERE nominations.round_id = ?
        ORDER BY nominations.order ASC, nominations.id ASC
      `,
      [req.query.roundId],
    );

    round.game_modes = groupBy<RoundGameMode['game_mode'], RoundGameMode>(
      await db.query<RoundGameMode>(
        `
          SELECT *
          FROM round_game_modes
          WHERE round_id = ?
        `,
        [req.query.roundId],
      ),
      'game_mode',
      null,
      true,
    );

    // TODO: Should not be necessary to check for uniques like this. Just fix query.
    //       See interop query as well
    nominations.forEach((nomination) => {
      nomination.beatmaps = (
        includesByNominationId[nomination.id]
          .map((include) => include.beatmap)
          .filter(
            (b1, i, all) => b1 != null && all.findIndex((b2) => b1.id === b2?.id) === i,
          ) as (Beatmap & { excluded: boolean })[]
      )
        .sort((a, b) => a.star_rating - b.star_rating)
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        .sort((a, b) => a.key_count! - b.key_count!);
      nomination.beatmapset_creators = includesByNominationId[nomination.id]
        .map((include) => include.creator)
        .filter(
          (c1, i, all) => c1 != null && all.findIndex((c2) => c1.id === c2?.id) === i,
        ) as User[];
      nomination.nominators = nominatorsByNominationId[nomination.id] || [];

      const assignees = assigneesByNominationId[nomination.id] || [];

      nomination.metadata_assignees = assignees
        .filter((a) => a.assignee_type === 0)
        .map((a) => a.assignee);
      nomination.moderator_assignees = assignees
        .filter((a) => a.assignee_type === 1)
        .map((a) => a.assignee);
    });

    res.json({
      nominations,
      round,
    });
  }),
);

router.post(
  '/nomination-submit',
  asyncHandler(async (req, res) => {
    if (typeof req.body.beatmapsetId !== 'number') {
      return res.status(422).json({ error: 'Invalid beatmapset ID' });
    }

    if (!isGameMode(req.body.gameMode)) {
      return res.status(422).json({ error: 'Invalid game mode' });
    }

    // TODO: can this be done with foreign constraint instead?
    if (req.body.parentId != null) {
      const parentNomination = await db.queryOne(
        `
          SELECT 1
          FROM nominations
          WHERE id = ?
        `,
        [req.body.parentId],
      );

      if (parentNomination == null) {
        return res.status(422).json({ error: 'Invalid parent nomination ID' });
      }
    }

    const beatmapset = await res.typedLocals.osu.createOrRefreshBeatmapset(req.body.beatmapsetId);

    if (beatmapset == null) {
      return res.status(422).json({ error: 'Invalid beatmapset ID' });
    }

    if (!beatmapset.game_modes.has(req.body.gameMode)) {
      return res.status(422).json({
        error: `Beatmapset has no beatmaps in game mode ${req.body.gameMode}`,
      });
    }

    const existingNomination = await db.queryOne(
      `
        SELECT 1
        FROM nominations
        WHERE round_id = ?
          AND game_mode = ?
          AND beatmapset_id = ?
      `,
      [req.body.roundId, req.body.gameMode, beatmapset.id],
    );

    if (existingNomination != null) {
      return res.status(422).json({
        error: "Duplicate nomination. Refresh the page if you don't see it",
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const nominationCount = (await db.queryOne<{ count: number }>(
      `
        SELECT COUNT(*) AS count
        FROM nominations
        WHERE round_id = ?
          AND game_mode = ?
      `,
      [req.body.roundId, req.body.gameMode],
    ))!.count;
    // TODO can't actually be undefined but TS doesn't see that it's assigned in transaction below
    let nominationId: Nomination['id'] | undefined;

    await db.transact(async (connection) => {
      nominationId = (
        await connection.query('INSERT INTO nominations SET ?', [
          {
            beatmapset_id: beatmapset.id,
            game_mode: req.body.gameMode,
            order: nominationCount,
            parent_id: req.body.parentId,
            round_id: req.body.roundId,
          },
        ])
      ).insertId;

      await connection.query(`INSERT INTO nomination_nominators SET ?`, [
        {
          nomination_id: nominationId,
          nominator_id: res.typedLocals.user.id,
        },
      ]);
    });

    const creators = await db.query<User>(
      `
        SELECT users.*
        FROM beatmapset_creators
        INNER JOIN nominations
          ON beatmapset_creators.beatmapset_id = nominations.beatmapset_id
            AND beatmapset_creators.game_mode = nominations.game_mode
        INNER JOIN users
          ON beatmapset_creators.creator_id = users.id
        WHERE nominations.id = ?
      `,
      [nominationId],
    );
    const nomination: Nomination & {
      beatmaps?: (Beatmap & { excluded: false })[];
      beatmapset?: Beatmapset;
      beatmapset_creators?: User[];
      description_author: null;
      metadata_assignees?: [];
      moderator_assignees?: [];
      nominators?: User[];
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    } = (await db.queryOne<Nomination & { description_author: null }>(
      `
        SELECT *, NULL AS description_author
        FROM nominations
        WHERE id = ?
      `,
      [nominationId],
    ))!;
    const beatmaps = await db.query<Beatmap & { excluded: false }>(
      `
        SELECT *, FALSE AS excluded
        FROM beatmaps
        WHERE beatmapset_id = ?
          AND game_mode = ?
        ORDER BY key_count ASC, star_rating ASC
      `,
      [nomination.beatmapset_id, req.body.gameMode],
    );
    const nominators = await db.query<User>(
      `
        SELECT users.*
        FROM nomination_nominators
        INNER JOIN users
          ON nomination_nominators.nominator_id = users.id
        WHERE nomination_nominators.nomination_id = ?
      `,
      [nominationId],
    );

    nomination.beatmaps = beatmaps;
    nomination.beatmapset = beatmapset;
    nomination.beatmapset_creators = creators || [];
    nomination.nominators = nominators || [];
    nomination.metadata_assignees = [];
    nomination.moderator_assignees = [];

    // TODO: log me!

    res.json(nomination);
  }),
);

router.post(
  '/nomination-edit-description',
  asyncHandler(async (req, res) => {
    const existingNomination = await db.queryOne<
      Pick<Nomination, 'description' | 'description_author_id' | 'description_state' | 'game_mode'>
    >(
      `
        SELECT description, description_author_id, description_state, game_mode
        FROM nominations
        WHERE id = ?
      `,
      [req.body.nominationId],
    );

    if (existingNomination == null) {
      return res.status(422).json({ error: 'Invalid nomination ID' });
    }

    const {
      description: prevDescription,
      description_author_id: prevAuthorId,
      description_state: prevState,
      game_mode: gameMode,
    } = existingNomination;
    const roles = authRoles(req, res);

    if (
      !(prevState !== DescriptionState.reviewed && roles.gameModes[gameMode]) &&
      !(prevDescription != null && roles.news)
    ) {
      return res.status(403).send();
    }

    if (!roles.gameModes[gameMode] && req.body.description == null) {
      return res.status(403).json({ error: "Can't remove description as editor" });
    }

    await db.query(
      `
        UPDATE nominations
        SET description = ?, description_author_id = ?, description_state = ?
        WHERE id = ?
      `,
      [
        req.body.description,
        req.body.description == null
          ? null
          : prevDescription == null
          ? res.typedLocals.user.id
          : prevAuthorId,
        roles.news && prevDescription != null && req.body.description != null
          ? DescriptionState.reviewed
          : DescriptionState.notReviewed,
        req.body.nominationId,
      ],
    );

    const nomination = await db.queryOneWithGroups<
      Nomination & { description_author: User | null }
    >(
      `
        SELECT nominations.*, description_authors:description_author
        FROM nominations
        LEFT JOIN users AS description_authors
          ON nominations.description_author_id = description_authors.id
        WHERE nominations.id = ?
      `,
      [req.body.nominationId],
    );

    res.json(nomination);
  }),
);

router.post(
  '/nomination-edit-metadata',
  asyncHandler(async (req, res) => {
    const roles = authRoles(req, res);

    if (!roles.metadata && !roles.news) {
      return res.status(403).json({ error: 'Must be a metadata checker or news author' });
    }

    const nomination:
      | (Pick<Nomination, 'beatmapset_id' | 'game_mode' | 'metadata_state'> & {
          beatmapset_creators?: User[];
        })
      | null = await db.queryOne<
      Pick<Nomination, 'beatmapset_id' | 'game_mode' | 'metadata_state'>
    >(
      `
        SELECT beatmapset_id, game_mode, metadata_state
        FROM nominations
        WHERE id = ?
      `,
      [req.body.nominationId],
    );

    if (nomination == null) {
      return res.status(422).json({ error: 'Invalid nomination ID' });
    }

    await db.transact(async (connection) => {
      if (roles.metadata) {
        let artist = req.body.artist;
        let title = req.body.title;

        if (req.body.state === MetadataState.good) {
          artist = null;
          title = null;

          if (nomination.metadata_state === MetadataState.needsChange) {
            await res.typedLocals.osu.createOrRefreshBeatmapset(nomination.beatmapset_id, true);
          }
        }

        await connection.query(
          `
            UPDATE nominations
            SET metadata_state = ?, overwrite_artist = ?, overwrite_title = ?
            WHERE id = ?
          `,
          [req.body.state, artist, title, req.body.nominationId],
        );
      }

      Object.assign(
        nomination,
        await connection.queryOneWithGroups<Nomination & { beatmapset: Beatmapset }>(
          `
            SELECT nominations.*, beatmapsets:beatmapset
            FROM nominations
            INNER JOIN beatmapsets
              ON nominations.beatmapset_id = beatmapsets.id
            WHERE nominations.id = ?
          `,
          [req.body.nominationId],
        ),
      );

      await connection.query(
        'DELETE FROM beatmapset_creators WHERE beatmapset_id = ? AND game_mode = ?',
        [nomination.beatmapset_id, nomination.game_mode],
      );

      const creators: User[] = [];

      if (isStringArray(req.body.creators) && req.body.creators.length > 0) {
        for (const creatorName of req.body.creators) {
          creators.push(
            await res.typedLocals.osu.createOrRefreshUser(creatorName, {
              byName: true,
              storeBanned: true,
            }),
          );
        }

        await connection.query(
          'INSERT INTO beatmapset_creators (beatmapset_id, creator_id, game_mode) VALUES ?',
          [creators.map((user) => [nomination.beatmapset_id, user.id, nomination.game_mode])],
        );
      }

      nomination.beatmapset_creators = creators;
    });

    res.json(nomination);
  }),
);

router.post(
  '/nomination-edit-moderation',
  isModerator,
  asyncHandler(async (req, res) => {
    await db.query('UPDATE nominations SET moderator_state = ? WHERE id = ?', [
      req.body.state,
      req.body.nominationId,
    ]);

    res.json({
      id: req.body.nominationId,
      moderator_state: req.body.state,
    });
  }),
);

router.delete(
  '/nomination',
  asyncHandler(async (req, res) => {
    if (!res.typedLocals.user.roles.god) {
      if (
        (await db.queryOne(
          `
            SELECT 1
            FROM nomination_nominators
            WHERE nomination_id = ?
              AND nominator_id = ?
          `,
          [req.query.nominationId, res.typedLocals.user.id],
        )) == null
      ) {
        return res.status(403).send();
      }
    }

    await db.transact(async (connection) => {
      await connection.query('DELETE FROM nomination_assignees WHERE nomination_id = ?', [
        req.query.nominationId,
      ]);
      await connection.query('DELETE FROM nomination_excluded_beatmaps WHERE nomination_id = ?', [
        req.query.nominationId,
      ]);
      await connection.query('DELETE FROM nomination_nominators WHERE nomination_id = ?', [
        req.query.nominationId,
      ]);
      await connection.query('DELETE FROM nominations WHERE id = ?', [req.query.nominationId]);
    });

    res.status(204).send();
  }),
);

router.post(
  '/update-nomination-order',
  isCaptain,
  asyncHandler(async (req, res) => {
    await db.transact((connection) =>
      Promise.all(
        Object.entries(req.body).map(([nominationId, order]) =>
          connection.query(
            `
              UPDATE nominations
              SET \`order\` = ?
              WHERE id = ?
            `,
            [order, nominationId],
          ),
        ),
      ),
    );

    res.status(204).send();
  }),
);

router.post(
  '/update-nominators',
  isCaptain,
  asyncHandler(async (req, res) => {
    await db.transact(async (connection) => {
      await connection.query('DELETE FROM nomination_nominators WHERE nomination_id = ?', [
        req.body.nominationId,
      ]);

      if (isNumberArray(req.body.nominatorIds) && req.body.nominatorIds.length > 0) {
        await connection.query(
          'INSERT INTO nomination_nominators (nomination_id, nominator_id) VALUES ?',
          [req.body.nominatorIds.map((id) => [req.body.nominationId, id])],
        );
      }
    });

    const nominators = await db.query<User>(
      `
        SELECT users.*
        FROM nomination_nominators
        INNER JOIN users
          ON nomination_nominators.nominator_id = users.id
        WHERE nomination_nominators.nomination_id = ?
      `,
      [req.body.nominationId],
    );

    res.json({
      id: req.body.nominationId,
      nominators: nominators || [],
    });
  }),
);

router.post(
  '/lock-nominations',
  asyncHandler(async (req, res) => {
    if (!isGameMode(req.body.gameMode)) {
      return res.status(422).json({ error: 'Invalid game mode' });
    }

    const roles = authRoles(req, res);

    if (!roles.news && !roles.gameModes[req.body.gameMode]) {
      return res.status(403).json({ error: 'Must be a news author or captain for this game mode' });
    }

    await db.query(
      'UPDATE round_game_modes SET nominations_locked = ? WHERE round_id = ? AND game_mode = ?',
      [req.body.lock, req.body.roundId, req.body.gameMode],
    );

    res.status(204).send();
  }),
);
//#endregion

//#region admin
router.post(
  '/add-user',
  isGod,
  asyncHandler(async (req, res) => {
    if (typeof req.body.name !== 'string') {
      return res.status(422).json({ error: 'Invalid username' });
    }

    const user: (User & { roles?: UserRoles & { user_id?: number } }) | null =
      await res.typedLocals.osu.createOrRefreshUser(req.body.name, {
        byName: true,
      });

    if (user == null) {
      return res.status(422).json({ error: 'Invalid username' });
    }

    await db.query('INSERT IGNORE INTO user_roles SET user_id = ?', [user.id]);

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    user.roles = (await db.queryOne<UserRoles>(
      `
        SELECT *
        FROM user_roles
        WHERE user_id = ?
      `,
      [user.id],
    ))!;
    delete user.roles.user_id;

    res.json(user);
  }),
);

router.post('/add-round', isNewsAuthor, (_, res) => {
  db.transact(async (connection) => {
    const queryResult = await connection.query("INSERT INTO rounds SET name = 'Unnamed round'");

    for (const gameMode of [0, 1, 2, 3]) {
      // TODO: 1 query instead of 4
      await connection.query('INSERT INTO round_game_modes SET ?', [
        {
          game_mode: gameMode,
          round_id: queryResult.insertId,
          voting_threshold: accessSetting(`defaultVotingThreshold.${gameMode}`) ?? 0,
        },
      ]);
    }

    res.json({ id: queryResult.insertId });
  });
});

router.post(
  '/update-round',
  isNewsAuthor,
  asyncHandler(async (req, res) => {
    if (!isRecord(req.body.round)) {
      return res.status(422).json({ error: 'Invalid round params' });
    }

    if (typeof req.body.roundId !== 'number') {
      return res.status(422).json({ error: 'Invalid round ID' });
    }

    await db.query('UPDATE rounds SET ? WHERE id = ?', [
      getParams(req.body.round, [
        'name',
        'news_intro',
        'news_intro_preview',
        'news_outro',
        'news_posted_at',
      ]),
      req.body.roundId,
    ]);

    res.status(204).send();
  }),
);

router.get(
  '/assignees',
  asyncHandler(async (_, res) => {
    const metadatas = await db.query<User>(`
      SELECT users.*
      FROM users
      INNER JOIN user_roles
        ON users.id = user_roles.user_id
      WHERE user_roles.metadata = 1
    `);
    const moderators = await db.query<User>(`
      SELECT users.*
      FROM users
      INNER JOIN user_roles
        ON users.id = user_roles.user_id
      WHERE user_roles.moderator = 1
    `);

    res.json({
      metadatas,
      moderators,
    });
  }),
);

router.post(
  '/update-excluded-beatmaps',
  isCaptain,
  asyncHandler(async (req, res) => {
    await db.transact(async (connection) => {
      await connection.query('DELETE FROM nomination_excluded_beatmaps WHERE nomination_id = ?', [
        req.body.nominationId,
      ]);

      if (isNumberArray(req.body.excludedBeatmapIds) && req.body.excludedBeatmapIds.length > 0) {
        await connection.query(
          'INSERT INTO nomination_excluded_beatmaps (beatmap_id, nomination_id) VALUES ?',
          [req.body.excludedBeatmapIds.map((id) => [id, req.body.nominationId])],
        );
      }
    });

    res.status(204).send();
  }),
);

router.post(
  '/update-nomination-assignees',
  asyncHandler(async (req, res) => {
    const types = {
      [AssigneeType.metadata]: 'metadata',
      [AssigneeType.moderator]: 'moderator',
    } as const;

    if (!isAssigneeType(req.body.type)) {
      return res.status(422).json({ error: 'Invalid assignee type' });
    }

    const roles = authRoles(req, res);
    const typeString = types[req.body.type];

    if (!roles.news && !roles[typeString]) {
      return res.status(403).json({ error: `Must have ${typeString} or news role` });
    }

    await db.transact(async (connection) => {
      await connection.query(
        `
          DELETE FROM nomination_assignees
          WHERE nomination_id = ?
            AND type = ?
        `,
        [req.body.nominationId, req.body.type],
      );

      if (isNumberArray(req.body.assigneeIds) && req.body.assigneeIds.length > 0) {
        await connection.query(
          'INSERT INTO nomination_assignees (assignee_id, nomination_id, type) VALUES ?',
          [req.body.assigneeIds.map((id) => [id, req.body.nominationId, req.body.type])],
        );
      }
    });

    const assignees = await db.query<User>(
      `
        SELECT users.*
        FROM nomination_assignees
        INNER JOIN users
          ON nomination_assignees.assignee_id = users.id
        WHERE nomination_assignees.nomination_id = ?
          AND nomination_assignees.type = ?
      `,
      [req.body.nominationId, req.body.type],
    );

    res.json({
      id: req.body.nominationId,
      [`${typeString}_assignees`]: assignees || [],
    });
  }),
);

router.get(
  '/users-with-permissions',
  asyncHandler(async (_, res) => {
    const queryResult = await db.queryWithGroups<UserWithRoles>(`
      SELECT users.*, user_roles:roles
      FROM users
      INNER JOIN user_roles
        ON users.id = user_roles.user_id
    `);

    res.json(queryResult);
  }),
);

router.post(
  '/update-permissions',
  isGod,
  asyncHandler(async (req, res) => {
    await db.query('UPDATE user_roles SET ? WHERE user_id = ?', [
      getParams(req.body, [
        'alumni',
        'alumni_game_mode',
        'captain',
        'captain_game_mode',
        'dev',
        'god',
        'god_readonly',
        'metadata',
        'moderator',
        'news',
      ]),
      req.body.userId,
    ]);

    res.status(204).send();
  }),
);

router.post(
  '/update-api-object',
  isGod,
  asyncHandler(async (req, res) => {
    if (typeof req.body.id !== 'number') {
      return res.status(422).json({ error: 'Invalid ID' });
    }

    if (req.body.type !== 'beatmapset' && req.body.type !== 'user') {
      return res.status(422).json({ error: 'Invalid type' });
    }

    let apiObject;

    switch (req.body.type) {
      case 'beatmapset':
        apiObject = await res.typedLocals.osu.createOrRefreshBeatmapset(req.body.id, true);
        break;
      case 'user':
        // TODO: Store banned only if some box is ticked on web form
        apiObject = await res.typedLocals.osu.createOrRefreshUser(req.body.id, {
          forceUpdate: true,
          storeBanned: true,
        });
        break;
    }

    if (apiObject == null) {
      return res.status(422).json({ error: 'Invalid ID' });
    }

    res.status(204).send();
  }),
);

router.post('/update-api-object-bulk', isGod, (req, res) => {
  let apiObject;
  const type = req.body.type;

  (async () => {
    for (const id of req.body.ids) {
      switch (type) {
        case 'beatmapset':
          apiObject = await res.typedLocals.osu.createOrRefreshBeatmapset(id, true);
          break;
        case 'user':
          // TODO: Store banned only if some box is ticked on web form
          apiObject = await res.typedLocals.osu.createOrRefreshUser(id, {
            forceUpdate: true,
            storeBanned: true,
          });
          break;
      }

      if (apiObject == null) {
        systemLog(`Could not update ${id} from bulk request`, SyslogLevel.warning);
      } else {
        systemLog(`Updated object ${id} from bulk request`, SyslogLevel.info);
      }

      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  })();

  res.status(204).send();
});

router.get('/settings', isCaptain, (_, res) => {
  res.json(settings);
});

router.put('/settings', isCaptain, (req, res) => {
  updateSettings(req.body);
  res.json(settings);
});
//#endregion