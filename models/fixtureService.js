// services/tournament/fixtureService.js

const { Fixture } = require('./Tournament');

async function createFixture(data) {
  return Fixture.create(data);
}

async function getFixtures(guildId) {
  return Fixture.find({ guildId });
}

async function getPendingFixtures(guildId) {
  return Fixture.find({ guildId, status: 'Pending' });
}

async function getNextMatch(guildId, teamName) {
  return Fixture.findOne({
    guildId,
    status: 'Pending',
    $or: [{ homeTeam: teamName }, { awayTeam: teamName }]
  }).sort({ scheduledAt: 1 });
}

async function reportMatch(matchId, result) {
  return Fixture.findByIdAndUpdate(
    matchId,
    {
      status: 'Played',
      result
    },
    { new: true }
  );
}

module.exports = {
  createFixture,
  getFixtures,
  getPendingFixtures,
  getNextMatch,
  reportMatch
};