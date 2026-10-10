const { REST, Routes } = require('discord.js');
const { token, clientId, guildId } = require('./config.json');
const fs = require('node:fs');
const path = require('node:path');
const { fitSlashCommandsToLimit } = require('./utils/slashCommandLimit');

const commandEntries = [];

const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
    const commandsPath = path.join(foldersPath, folder);

    if (!fs.lstatSync(commandsPath).isDirectory()) continue;

    const commandFiles = fs
        .readdirSync(commandsPath)
        .filter(file => file.endsWith('.js'));

    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);

        try {
            delete require.cache[require.resolve(filePath)];

            const command = require(filePath);

            if (!command.data) {
                console.log(`⚠️ Skipped ${folder}/${file} — missing data`);
                continue;
            }

            const json = command.data.toJSON();

            fixRequiredOptionOrder(json);

            commandEntries.push({
                hidden: command.hidden === true,
                name: json.name,
                folder,
                file,
                json
            });
        } catch (error) {
            console.error(`❌ Failed loading command ${folder}/${file}`);
            console.error(error);
        }
    }
}

const { selected: selectedCommandEntries, omitted: omittedCommandEntries } = fitSlashCommandsToLimit(commandEntries);
const commands = selectedCommandEntries.map(entry => entry.json);
const commandDebugList = selectedCommandEntries.map((entry, index) => ({ ...entry, index }));
if (omittedCommandEntries.length) {
    console.warn(`⚠️ Discord allows at most 100 global chat-input commands. Visible commands are prioritized; omitted commands remain prefix-accessible where supported: ${omittedCommandEntries.map(command => command.name).join(', ')}`);
}

console.log('\n📦 Commands prepared:');
for (const item of commandDebugList) {
    console.log(
        `${String(item.index).padStart(2, '0')} | ${item.name} | ${item.folder}/${item.file}`
    );
}

validateCommandOptions(commands);

const rest = new REST().setToken(token);

(async () => {
    try {
        console.log(`\n🌍 Deploying ${commands.length} GLOBAL command(s)...`);

        await rest.put(
            Routes.applicationCommands(clientId),
            { body: commands }
        );

        console.log('✅ Global deployment complete.');

        if (guildId) {
            console.log('\n🧹 Clearing old guild-only commands from main server...');

            await rest.put(
                Routes.applicationGuildCommands(clientId, guildId),
                { body: [] }
            );

            console.log('✅ Old guild commands cleared.');
        }

        console.log('\n✅ Deployment Complete!');
        console.log('Note: Global slash commands can take some time to fully appear/update across Discord.');
    } catch (error) {
        console.error('\n❌ Deployment Error:', error);

        if (error?.rawError?.errors) {
            console.error('\nDiscord raw errors:');
            console.dir(error.rawError.errors, { depth: 10 });
        }

        console.log('\nCommand index map:');
        for (const item of commandDebugList) {
            console.log(
                `${String(item.index).padStart(2, '0')} | ${item.name} | ${item.folder}/${item.file}`
            );
        }
    }
})();

function fixRequiredOptionOrder(commandOrOption) {
    if (!commandOrOption || !Array.isArray(commandOrOption.options)) return;

    for (const option of commandOrOption.options) {
        fixRequiredOptionOrder(option);
    }

    commandOrOption.options.sort((a, b) => {
        const aRequired = a.required === true ? 1 : 0;
        const bRequired = b.required === true ? 1 : 0;

        if (aRequired !== bRequired) {
            return bRequired - aRequired;
        }

        return 0;
    });
}

function validateCommandOptions(commands) {
    let hasProblem = false;

    for (let i = 0; i < commands.length; i++) {
        const command = commands[i];

        const problems = findOptionOrderProblems(command);

        if (!problems.length) continue;

        hasProblem = true;

        console.log(`\n❌ Option order issue in command index ${i}: /${command.name}`);

        for (const problem of problems) {
            console.log(`Path: ${problem.path}`);
            console.table(problem.options);
        }
    }

    if (hasProblem) {
        throw new Error('Slash command option order validation failed.');
    }

    console.log('\n✅ Slash option order validation passed.');
}

function findOptionOrderProblems(commandOrOption, pathLabel = '') {
    const problems = [];

    if (!commandOrOption || !Array.isArray(commandOrOption.options)) {
        return problems;
    }

    let optionalSeen = false;

    const simpleOptions = commandOrOption.options.filter(option => {
        return option.type !== 1 && option.type !== 2;
    });

    for (let i = 0; i < simpleOptions.length; i++) {
        const option = simpleOptions[i];

        if (option.required !== true) {
            optionalSeen = true;
        }

        if (optionalSeen && option.required === true) {
            problems.push({
                path: pathLabel || commandOrOption.name || 'root',
                options: simpleOptions.map(opt => ({
                    name: opt.name,
                    required: opt.required === true
                }))
            });

            break;
        }
    }

    for (const option of commandOrOption.options) {
        problems.push(
            ...findOptionOrderProblems(
                option,
                `${pathLabel || commandOrOption.name || 'root'} > ${option.name}`
            )
        );
    }

    return problems;
}