# Self-role panels

Self-role panels live in the non-tournament `roles` command category. Setup and management happen in Discord; there is no web dashboard. Public panels use **emoji reactions only**—they do not publish buttons or dropdowns.

## Guided setup

1. Give the bot **Manage Roles** and move its highest role above every role you plan to offer.
2. In the server, run bare `.selfroles`. The bot asks one question at a time and waits up to three minutes for each reply. Type `cancel` at any point to stop without saving a panel.
3. Choose the embed heading, write the intro/instructions exactly as members should see them (Markdown and multiple lines are supported), choose an accent color, and select the channel and choice rules.
4. Add role choices. For each, choose a role and unique emoji, set the visible label, write optional custom embed text, choose a duration (`permanent`, `12h`, `7d`, and so on), and optionally mention up to four bundled roles. Reply `done` when finished.
5. Choose `publish` to post the panel immediately, or `draft` to save it and publish later.

The wizard supports one choice group and up to 20 reaction roles per panel. Intro text is limited to 1,500 characters and custom text per role to 500 characters. A `-` reply skips optional copy. Custom panel wording cannot trigger role or everyone mentions.

## Advanced configuration

The slash command supports additional groups, gates, dependencies, bundles, timed grants, previews, audit logging, cloning, and panel lifecycle controls:

- `/selfroles create` makes a draft with a custom heading and intro.
- `/selfroles group` configures single- or multiple-choice rules. Reaction panels cannot enforce minimum picks because members can remove reactions at any time; use a minimum of zero.
- `/selfroles role` adds a role with a reaction emoji, label, optional embed text, duration, up to four bundled roles, and optional prerequisite, blocked, or exclusion roles.
- `/selfroles preview` privately previews the reaction embed, and `/selfroles publish` posts or refreshes it.
- `/selfroles audit`, `/selfroles clone`, `/selfroles pause`, `/selfroles resume`, and `/selfroles delete` provide additional management.

Panels and timed-grant records persist in the database. Timed roles expire automatically after a duration from one minute to 90 days. A bundled role that the member held independently is preserved when a grant is removed or expires. Deleting a panel leaves permanent roles already granted in place; active timed grants continue until expiry.

## Member experience and safeguards

Members add a role by reacting with its matching emoji and remove it by removing that reaction. In a single-choice group, reacting to another option replaces the previous choice. Multiple-choice groups may have a maximum; a rejected reaction is removed. `/roleprefs` privately lists the member’s current roles and explains how to change them.

Reaction publishing requires the bot to have **View Channel**, **Read Message History**, **Send Messages**, **Embed Links**, **Add Reactions**, and **Manage Messages** in the target channel, plus **Manage Roles** and a role hierarchy above every offered or bundled role. Managed roles, roles above the bot, and roles carrying sensitive permissions are rejected. Role safety is checked again before publishing and granting.
