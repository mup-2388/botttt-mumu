const { EmbedBuilder } = require('discord.js');
const axios = require('axios');
const celebrations = require('./celebrationData');
const { vsLine, slotEmoji } = require('./ai/emojiSlots');

const random = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function checkGoals(client) {
    try {
        // 1. Fetch ALL live/scheduled matches from API
        const response = await axios.get('https://api.football-data.org/v4/matches', {
            headers: { 'X-Auth-Token': process.env.FOOTBALL_API_KEY }
        });

        if (!response.data.matches) return;

        // 2. Loop through every Guild that has configured alerts
        const activeGuilds = client.liveSettings.keys(); 

        for (const guildId of activeGuilds) {
            const guildSettings = client.liveSettings.get(guildId);
            if (!guildSettings || !guildSettings.channelId || !guildSettings.leagues) continue;

            const channel = client.channels.cache.get(guildSettings.channelId);
            if (!channel) continue;

            // 3. Filter matches based on the guild's selected leagues
            const subscribedMatches = response.data.matches.filter(m => 
                guildSettings.leagues.includes(m.competition.code)
            );

            for (const match of subscribedMatches) {
                const matchId = match.id.toString();
                // Get cache or set default
                const cache = client.matchCache.get(matchId) || { home: 0, away: 0, status: 'SCHEDULED', timestamp: Date.now() };
                
                const curHome = match.score.fullTime.home || 0;
                const curAway = match.score.fullTime.away || 0;
                const homeTeam = match.homeTeam.name;
                const awayTeam = match.awayTeam.name;
                const status = match.status;

                // Identify if a "Big Team" is playing
                const teamKey = Object.keys(celebrations).find(k => homeTeam.includes(k) || awayTeam.includes(k));
                const club = celebrations[teamKey];

                // --- 🎬 KICK OFF ---
                if (status === 'IN_PLAY' && (cache.status === 'SCHEDULED' || cache.status === 'TIMED')) {
                    const startEmbed = new EmbedBuilder()
                        .setColor(club ? club.color : 0x3498DB)
                        .setTitle(`🎬 KICK OFF: ${vsLine(homeTeam, awayTeam, guildId)}`)
                        .setDescription(`### "${club && club.startQuotes ? random(club.startQuotes) : random(celebrations.GLOBAL_ALERTS.kickOff)}"`)
                        .setFooter({ text: `${match.competition.name}` });
                    
                    channel.send({ embeds: [startEmbed] });
                }

                // --- ⚽ GOAL DETECTION (With Smart Clutch) ---
                if (curHome !== cache.home || curAway !== cache.away) {
                    const minute = match.minute || "??";
                    const isLate = parseInt(minute) >= 85;
                    const isEqualizer = (curHome === curAway);
                    const isWinnerChange = (cache.home === cache.away) && (curHome !== curAway);
                    const isClutch = isLate && (isEqualizer || isWinnerChange);

                    const goalEmbed = new EmbedBuilder()
                        .setColor(isClutch ? 0xE67E22 : (club ? club.color : 0x2ECC71))
                        .setTitle(isClutch ? `🔥 CLUTCH GOAL!` : `${slotEmoji('goals', guildId)} GOAL: ${curHome > cache.home ? homeTeam : awayTeam}`)
                        .setDescription(`**${homeTeam} ${curHome} - ${curAway} ${awayTeam}**\n*Minute: ${minute}'*`)
                        .setTimestamp();
                    
                    channel.send({ embeds: [goalEmbed] });
                }

                // --- ⏸️ HALF TIME ---
                if (status === 'PAUSED' && cache.status !== 'PAUSED') {
                    const htEmbed = new EmbedBuilder()
                        .setColor(0xF1C40F)
                        .setTitle(`⏸️ HALF TIME: ${homeTeam} ${slotEmoji('goals', guildId)} ${curHome} - ${curAway} ${slotEmoji('goals', guildId)} ${awayTeam}`)
                        .setDescription(`### "${random(celebrations.GLOBAL_ALERTS.halfTime)}"`);
                    
                    channel.send({ embeds: [htEmbed] });
                }

                // --- 🏁 FULL TIME / CELEBRATION / TRAGEDY ---
                if ((status === 'FINISHED' || status === 'FT') && cache.status !== 'FINISHED') {
                    // Disaster Check for Real Madrid (Competition code 'PD' is La Liga)
                    const isLaLiga = match.competition.code === 'PD';
                    const isMadrid = homeTeam.includes("Real Madrid") || awayTeam.includes("Real Madrid");
                    const madridWon = isMadrid && ((homeTeam.includes("Real Madrid") && curHome > curAway) || (awayTeam.includes("Real Madrid") && curAway > curHome));
                    const isDraw = curHome === curAway;

                    if (isLaLiga && isMadrid && (isDraw || !madridWon)) {
                        const tragedy = celebrations["MADRID_TRAGEDY"];
                        const tragEmbed = new EmbedBuilder().setColor(tragedy.color).setTitle(`📉 DISASTER: POINTS DROPPED`).setDescription(`## "${random(tragedy.quotes)}"`).setImage(random(tragedy.images));
                        channel.send({ content: "💔 **The race is slipping away...**", embeds: [tragEmbed] });
                    } else {
                        const winner = curHome > curAway ? homeTeam : (curAway > curHome ? awayTeam : null);
                        const winKey = winner ? Object.keys(celebrations).find(k => winner.includes(k)) : null;

                        if (winKey) {
                            const clubWin = celebrations[winKey];
                            const winEmbed = new EmbedBuilder().setColor(clubWin.color).setTitle(`🏁 VICTORY: ${winner.toUpperCase()}`).setDescription(`## "${random(clubWin.quotes)}"`).setImage(random(clubWin.images));
                            channel.send({ embeds: [winEmbed] });
                        } else if (isDraw && curHome === 0) {
                            const draw = celebrations["DRAW"];
                            const drawEmbed = new EmbedBuilder().setColor(draw.color).setTitle(`🤝 0-0 STALEMATE`).setDescription(`### "${random(draw.quotes)}"`).setImage(random(draw.images));
                            channel.send({ embeds: [drawEmbed] });
                        } else {
                            const wallTeam = curAway === 0 ? homeTeam : (curHome === 0 ? awayTeam : null);
                            const finalEmbed = new EmbedBuilder()
                                .setColor(wallTeam ? 0x3498DB : 0x7F8C8D)
                                .setTitle(wallTeam ? `🧱 THE WALL: ${wallTeam.toUpperCase()}` : `🏁 FULL TIME: ${homeTeam} ${curHome}-${curAway} ${awayTeam}`);
                            channel.send({ embeds: [finalEmbed] });
                        }
                    }
                }

                // Update the Cache for this specific match
                client.matchCache.set(matchId, { 
                    home: curHome, 
                    away: curAway, 
                    status: status, 
                    timestamp: Date.now() 
                });
            }
        }
    } catch (err) {
        console.error("Match Alert Loop Error:", err.message);
    }
}

module.exports = { checkGoals };