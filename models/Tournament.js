const mongoose = require('mongoose');

/*
========================================
TOURNAMENT SETTINGS / TOURNAMENT
One server can now have multiple tournaments.
========================================
*/
const tournamentSettingsSchema = new mongoose.Schema(
    {
        guildId: {
            type: String,
            required: true,
            index: true
        },

        tournamentKey: {
            type: String,
            required: true,
            trim: true,
            lowercase: true
        },

        organizerIds: {
            type: [String],
            default: []
        },

        name: {
            type: String,
            default: 'HandFootball Season'
        },

        formatType: {
            type: String,
            enum: ['league', 'groups_knockout', 'mega_table_playoffs', 'club_world_cup', 'custom'],
            default: 'league'
        },

        schedulingMode: {
            type: String,
            enum: ['auto', 'manual_draw', 'hybrid'],
            default: 'auto'
        },

        teamCount: {
            type: Number,
            default: 0,
            min: 0
        },

        groupCount: {
            type: Number,
            default: 0,
            min: 0
        },

        teamsPerGroup: {
            type: Number,
            default: 0,
            min: 0
        },

        qualificationSpotsPerGroup: {
            type: Number,
            default: 2
        },

        uclQualificationSpots: {
            type: Number,
            default: 0
        },

        super8QualificationSpots: {
            type: Number,
            default: 4
        },

        standingsBackground: {
            type: String,
            default: null
        },

        homeAway: {
            type: Boolean,
            default: false
        },

        hasKnockout: {
            type: Boolean,
            default: false
        },

        knockoutRounds: {
            type: [String],
            default: []
        },

        twoLeggedRounds: {
            type: [String],
            default: []
        },

        finalNeutralVenue: {
            type: Boolean,
            default: true
        },

        currentPhase: {
            type: String,
            enum: ['registration', 'league', 'groups', 'super8', 'knockout', 'completed'],
            default: 'registration'
        },

        registrationOpen: {
            type: Boolean,
            default: true
        },

        // Manual registration mode: auto-sync (settournament / register /
        // addplayer) will NOT add teams or players to this tournament.
        // Captains must explicitly register via:
        //   /register team_name:<name> tournament:<key>
        //   /addplayer user:<user> tournament:<key>
        manualRegistration: {
            type: Boolean,
            default: false
        },

        captainRoleId: {
            type: String,
            default: ''
        },

        tournamentPlayerRoleId: {
            type: String,
            default: ''
        },

        manualGroupDraw: {
            type: Boolean,
            default: false
        },

        manualKnockoutDraw: {
            type: Boolean,
            default: false
        },

        autoGenerateGroupFixtures: {
            type: Boolean,
            default: false
        },

        autoSeedKnockouts: {
            type: Boolean,
            default: false
        },

        pointsWin: {
            type: Number,
            default: 3
        },

        pointsDraw: {
            type: Number,
            default: 1
        },

        pointsLoss: {
            type: Number,
            default: 0
        },

        emoji: {
            type: String,
            default: '🏆'
        }
    },
    { timestamps: true }
);

tournamentSettingsSchema.index(
    { guildId: 1, tournamentKey: 1 },
    { unique: true }
);

/*
========================================
TEAM
Server-wide team. NOT tournament-specific.
========================================
*/
const teamSchema = new mongoose.Schema(
    {
        guildId: {
            type: String,
            required: true,
            index: true
        },

        name: {
            type: String,
            required: true,
            trim: true
        },

        shortName: {
            type: String,
            default: ''
        },

        groupKey: {
            type: String,
            default: null
        },

        captainID: {
            type: String,
            default: null
        },

        viceCaptainID: {
            type: String,
            default: null
        },

        logoURL: {
            type: String,
            default: ''
        },

        color: {
            type: String,
            default: ''
        },

        stadium: {
            type: String,
            default: ''
        },

        // LEGACY / current league backup.
        // Do not delete yet.
        stats: {
            played: { type: Number, default: 0 },
            wins: { type: Number, default: 0 },
            draws: { type: Number, default: 0 },
            losses: { type: Number, default: 0 },
            gf: { type: Number, default: 0 },
            ga: { type: Number, default: 0 },
            points: { type: Number, default: 0 }
        }
    },
    { timestamps: true }
);

teamSchema.index({ guildId: 1, name: 1 }, { unique: true });

/*
========================================
PLAYER
Server-wide player. NOT tournament-specific.
========================================
*/
const playerSchema = new mongoose.Schema(
    {
        guildId: {
            type: String,
            required: true,
            index: true
        },

        name: {
            type: String,
            required: true,
            trim: true
        },

        discordID: {
            type: String,
            default: null
        },

        discordUsername: {
            type: String,
            default: null,
            trim: true,
            lowercase: true
        },

        teamId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Team',
            default: null
        },

        teamNameSnapshot: {
            type: String,
            default: ''
        },

        isCaptain: {
            type: Boolean,
            default: false
        },

        isViceCaptain: {
            type: Boolean,
            default: false
        },

        // LEGACY / current league backup.
        // Do not delete yet.
        stats: {
            played: { type: Number, default: 0 },
            goals: { type: Number, default: 0 },
            assists: { type: Number, default: 0 },
            saves: { type: Number, default: 0 },
            tackles: { type: Number, default: 0 },
            interceptions: { type: Number, default: 0 },
            yc: { type: Number, default: 0 },
            rc: { type: Number, default: 0 },
            mvps: { type: Number, default: 0 }
        }
    },
    { timestamps: true }
);

playerSchema.index(
    { guildId: 1, discordID: 1 },
    {
        unique: true,
        partialFilterExpression: { discordID: { $type: 'string' } }
    }
);

/*
========================================
TOURNAMENT TEAM
A team entry inside one tournament.
This stores tournament-specific table stats.
========================================
*/
const tournamentTeamSchema = new mongoose.Schema(
    {
        guildId: {
            type: String,
            required: true,
            index: true
        },

        tournamentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'TournamentSettings',
            required: true,
            index: true
        },

        teamId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Team',
            required: true,
            index: true
        },

        teamNameSnapshot: {
            type: String,
            default: ''
        },

        // Per-tournament captain / vice captain.
        // Lets a user captain a team in this tournament even if they
        // manage a different team in another tournament.
        captainID: {
            type: String,
            default: null
        },

        viceCaptainID: {
            type: String,
            default: null
        },

        groupKey: {
            type: String,
            default: null
        },

        isActive: {
            type: Boolean,
            default: true
        },

        stats: {
            played: { type: Number, default: 0 },
            wins: { type: Number, default: 0 },
            draws: { type: Number, default: 0 },
            losses: { type: Number, default: 0 },
            gf: { type: Number, default: 0 },
            ga: { type: Number, default: 0 },
            points: { type: Number, default: 0 }
        }
    },
    { timestamps: true }
);

tournamentTeamSchema.index(
    { guildId: 1, tournamentId: 1, teamId: 1 },
    { unique: true }
);

tournamentTeamSchema.index(
    { guildId: 1, tournamentId: 1, captainID: 1 }
);

/*
========================================
TOURNAMENT PLAYER
A player entry inside one tournament.
This stores tournament-specific player stats.
========================================
*/
const tournamentPlayerSchema = new mongoose.Schema(
    {
        guildId: {
            type: String,
            required: true,
            index: true
        },

        tournamentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'TournamentSettings',
            required: true,
            index: true
        },

        playerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Player',
            required: true,
            index: true
        },

        teamId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Team',
            default: null,
            index: true
        },

        playerNameSnapshot: {
            type: String,
            default: ''
        },

        teamNameSnapshot: {
            type: String,
            default: ''
        },

        isActive: {
            type: Boolean,
            default: true
        },

        isCaptain: {
            type: Boolean,
            default: false
        },

        isViceCaptain: {
            type: Boolean,
            default: false
        },

        stats: {
            played: { type: Number, default: 0 },
            goals: { type: Number, default: 0 },
            assists: { type: Number, default: 0 },
            saves: { type: Number, default: 0 },
            tackles: { type: Number, default: 0 },
            interceptions: { type: Number, default: 0 },
            yc: { type: Number, default: 0 },
            rc: { type: Number, default: 0 },
            mvps: { type: Number, default: 0 }
        }
    },
    { timestamps: true }
);

tournamentPlayerSchema.index(
    { guildId: 1, tournamentId: 1, playerId: 1 },
    { unique: true }
);

/*
========================================
EVENT SETTINGS
Freestyle event for daily tracking (UCL etc)
No teams, channel-bound, .as auto-routes
========================================
*/
const eventSettingsSchema = new mongoose.Schema(
    {
        guildId: {
            type: String,
            required: true,
            index: true
        },

        eventKey: {
            type: String,
            required: true,
            trim: true,
            lowercase: true
        },

        name: {
            type: String,
            default: ''
        },

        channelId: {
            type: String,
            default: '',
            index: true
        },

        isActive: {
            type: Boolean,
            default: true
        },

        emoji: {
            type: String,
            default: '🏆'
        },

        createdBy: {
            type: String,
            default: ''
        }
    },
    { timestamps: true }
);

eventSettingsSchema.index(
    { guildId: 1, eventKey: 1 },
    { unique: true }
);

eventSettingsSchema.index(
    { guildId: 1, channelId: 1 }
);

/*
========================================
EVENT PLAYER
Player stats per event (no team required)
========================================
*/
const eventPlayerSchema = new mongoose.Schema(
    {
        guildId: {
            type: String,
            required: true,
            index: true
        },

        eventId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'EventSettings',
            required: true,
            index: true
        },

        playerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Player',
            required: true,
            index: true
        },

        playerNameSnapshot: {
            type: String,
            default: ''
        },

        isActive: {
            type: Boolean,
            default: true
        },

        stats: {
            played: { type: Number, default: 0 },
            goals: { type: Number, default: 0 },
            assists: { type: Number, default: 0 },
            saves: { type: Number, default: 0 },
            tackles: { type: Number, default: 0 },
            interceptions: { type: Number, default: 0 },
            yc: { type: Number, default: 0 },
            rc: { type: Number, default: 0 },
            mvps: { type: Number, default: 0 }
        }
    },
    { timestamps: true }
);

eventPlayerSchema.index(
    { guildId: 1, eventId: 1, playerId: 1 },
    { unique: true }
);

/*
========================================
FIXTURE
Tournament-specific fixture.
========================================
*/
const fixtureSchema = new mongoose.Schema(
    {
        guildId: {
            type: String,
            required: true,
            index: true
        },

        tournamentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'TournamentSettings',
            default: null,
            index: true
        },

        tournamentKey: {
            type: String,
            default: '',
            index: true
        },

        phase: {
            type: String,
            enum: [
                'league',
                'group',
                'super8',
                'qualifier',
                'eliminator',
                'quarterfinal',
                'semifinal',
                'final',
                'custom'
            ],
            required: true
        },

        roundLabel: {
            type: String,
            default: ''
        },

        groupKey: {
            type: String,
            default: null
        },

        leg: {
            type: Number,
            default: 1
        },

        matchNumber: {
            type: Number,
            default: 0
        },

        homeTeamId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Team',
            default: null
        },

        awayTeamId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Team',
            default: null
        },

        homeTournamentTeamId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'TournamentTeam',
            default: null
        },

        awayTournamentTeamId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'TournamentTeam',
            default: null
        },

        homeTeam: {
            type: String,
            required: true,
            trim: true
        },

        awayTeam: {
            type: String,
            required: true,
            trim: true
        },

        venueType: {
            type: String,
            enum: ['home', 'away', 'neutral'],
            default: 'home'
        },

        venueName: {
            type: String,
            default: ''
        },

        scheduledAt: {
            type: Date,
            default: null
        },

        /*
         * Match-day channel plan (see utils/matchScheduler.js):
         * the stadium channel is locked immediately and announced when scheduled,
         * then unlocked and pinged one minute before kickoff.
         */
        channelPlan: {
            channelId: { type: String, default: null },
            state: {
                type: String,
                enum: ['pending', 'locked', 'announced', 'done', 'cancelled'],
                default: 'pending'
            },
            lockAt: { type: Date, default: null },
            announceAt: { type: Date, default: null }, // one-minute-before unlock + final ping time
            lockedAt: { type: Date, default: null },
            announcedAt: { type: Date, default: null }, // legacy / reminder timestamp
            scheduledAnnouncementClaimedAt: { type: Date, default: null },
            scheduledAnnouncedAt: { type: Date, default: null },
            scheduledAnnouncementMessageId: { type: String, default: null },
            unlockClaimedAt: { type: Date, default: null },
            unlockedAt: { type: Date, default: null },
            unlockAnnouncedAt: { type: Date, default: null },
            unlockMessageId: { type: String, default: null },
            reminderClaimedAt: { type: Date, default: null }, // legacy reminder-only flow
            reminderAnnouncedAt: { type: Date, default: null }, // legacy reminder-only flow
            reminderMessageId: { type: String, default: null }, // legacy reminder-only flow
            kickoffClaimedAt: { type: Date, default: null }, // legacy kickoff-time flow
            kickoffUnlockedAt: { type: Date, default: null }, // legacy kickoff-time flow
            kickoffAnnouncedAt: { type: Date, default: null }, // legacy kickoff-time flow
            kickoffMessageId: { type: String, default: null }, // legacy kickoff-time flow
            lockedBy: { type: String, default: null },
            previousOverwrite: { type: mongoose.Schema.Types.Mixed, default: null },
            pingCaptains: { type: Boolean, default: false },
            announcementMessageId: { type: String, default: null },
            lastError: { type: String, default: null },
            scheduledBy: { type: String, default: null }
        },

        /*
         * A match the organizers could not play on its matchday. Reserved
         * fixtures stay Pending (so they can still be reported/played whenever),
         * keep their new kickoff in scheduledAt, and are flagged everywhere
         * fixtures are listed. Reserving also releases the stadium channel lock.
         */
        reserved: {
            isReserved: { type: Boolean, default: false },
            at: { type: Date, default: null },          // when it was marked
            by: { type: String, default: null },        // organizer user id
            from: { type: Date, default: null },        // kickoff that was missed
            until: { type: Date, default: null },       // new day/time (null = not decided)
            note: { type: String, default: null }
        },

        status: {
            type: String,
            enum: ['Pending', 'Live', 'Played', 'Cancelled'],
            default: 'Pending'
        },

        result: {
            home: { type: Number, default: null },
            away: { type: Number, default: null },
            extraTimeHome: { type: Number, default: null },
            extraTimeAway: { type: Number, default: null },
            penaltiesHome: { type: Number, default: null },
            penaltiesAway: { type: Number, default: null },
            winner: { type: String, default: '' }
        },

        aggregateTieKey: {
            type: String,
            default: null
        },

        notes: {
            type: String,
            default: ''
        },

        bracket: {
            advancesToMatchNumber: {
                type: Number,
                default: null
            },
            slot: {
                type: String,
                default: ''
            }
        }
    },
    { timestamps: true }
);

fixtureSchema.index({ guildId: 1, tournamentId: 1, matchNumber: 1 });
fixtureSchema.index({ guildId: 1, tournamentId: 1, status: 1 });
fixtureSchema.index({ guildId: 1, tournamentId: 1, phase: 1, roundLabel: 1 });

/*
========================================
USER PROFILE
All-time stats + awards + trophies.
Per-guild for stats; trophies/awards are
aggregated globally when displayed.
========================================
*/
const userProfileSchema = new mongoose.Schema(
    {
        guildId: {
            type: String,
            required: true,
            index: true
        },

        discordID: {
            type: String,
            required: true,
            index: true
        },

        displayName: {
            type: String,
            default: ''
        },

        allTimeStats: {
            played: { type: Number, default: 0 },
            goals: { type: Number, default: 0 },
            assists: { type: Number, default: 0 },
            saves: { type: Number, default: 0 },
            tackles: { type: Number, default: 0 },
            interceptions: { type: Number, default: 0 },
            mvps: { type: Number, default: 0 }
        },

        trophies: [
            {
                tournamentId: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: 'TournamentSettings',
                    default: null
                },
                tournamentKey: String,
                tournamentName: String,
                teamName: String,
                title: String,
                awardedAt: {
                    type: Date,
                    default: Date.now
                }
            }
        ],

        awards: [
            {
                tournamentId: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: 'TournamentSettings',
                    default: null
                },
                tournamentKey: String,
                tournamentName: String,
                awardType: {
                    type: String,
                    enum: ['ballon_dor', 'golden_boot', 'golden_glove', 'playmaker']
                },
                title: String,
                awardedAt: {
                    type: Date,
                    default: Date.now
                }
            }
        ]
    },
    { timestamps: true }
);

userProfileSchema.index(
    { guildId: 1, discordID: 1 },
    { unique: true }
);

/*
========================================
SERVER CONFIG
Server-wide settings, not tournament-specific.
========================================
*/
const serverConfigSchema = new mongoose.Schema(
    {
        guildId: {
            type: String,
            required: true,
            unique: true,
            index: true
        },

        defaultTournamentKey: {
            type: String,
            default: ''
        },

        defaultFixturesChannelId: {
            type: String,
            default: ''
        },

        organizerIds: {
            type: [String],
            default: []
        },

        aiOnlyChannels: {
            type: [String],
            default: []
        },

        aiEnabled: {
            type: Boolean,
            default: true
        },

        transfersLocked: {
            type: Boolean,
            default: false
        },

        // When false, setcolor is blocked and team-role sync preserves
        // whatever colors are already set on Discord roles.
        teamRoleColorsEnabled: {
            type: Boolean,
            default: true
        },

        emojis: {
            stats: {
            played: { type: String, default: '<:Stadium:1487010283506630776>' },
            goals: { type: String, default: '<:Goal:1488855482142556180>' },
            assists: { type: String, default: '<:Assist:1488530563500605532>' },
            saves: { type: String, default: '<:saves:1488530642127028358>' },
            tackles: { type: String, default: '<:tackles:1488530871668703255>' },
            interceptions: { type: String, default: '🧠' },
            mvps: { type: String, default: '<:mvp:1488530468184920195>' },
            ga: { type: String, default: '🔥' }
    },

            awards: {
            ballon_dor: { type: String, default: '🏆' },
            golden_boot: { type: String, default: '⚽' },
            golden_glove: { type: String, default: '🧤' },
            playmaker: { type: String, default: '🎯' }
    },

            trophy: {
            default: { type: String, default: '<:_Trophy:1507987705311793152>' },
            champion: { type: String, default: '<:_Trophy:1507987705311793152>' },
            runner_up: { type: String, default: '🥈' }
    }
        }
    },
    { timestamps: true }
);

/*
========================================
BLACKLIST
========================================
*/
const blacklistSchema = new mongoose.Schema(
    {
        userId: {
            type: String,
            required: true,
            unique: true
        },

        reason: {
            type: String,
            default: ''
        },

        date: {
            type: Date,
            default: Date.now
        }
    },
    { timestamps: true }
);

module.exports = {
    TournamentSettings: mongoose.models.TournamentSettings || mongoose.model('TournamentSettings', tournamentSettingsSchema),
    EventSettings: mongoose.models.EventSettings || mongoose.model('EventSettings', eventSettingsSchema),
    EventPlayer: mongoose.models.EventPlayer || mongoose.model('EventPlayer', eventPlayerSchema),
    Team: mongoose.models.Team || mongoose.model('Team', teamSchema),
    Player: mongoose.models.Player || mongoose.model('Player', playerSchema),
    TournamentTeam: mongoose.models.TournamentTeam || mongoose.model('TournamentTeam', tournamentTeamSchema),
    TournamentPlayer: mongoose.models.TournamentPlayer || mongoose.model('TournamentPlayer', tournamentPlayerSchema),
    Fixture: mongoose.models.Fixture || mongoose.model('Fixture', fixtureSchema),
    UserProfile: mongoose.models.UserProfile || mongoose.model('UserProfile', userProfileSchema),
    ServerConfig: mongoose.models.ServerConfig || mongoose.model('ServerConfig', serverConfigSchema),
    Blacklist: mongoose.models.Blacklist || mongoose.model('Blacklist', blacklistSchema)
};
