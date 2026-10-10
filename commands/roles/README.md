# Self-role panels

Self-role panels live in the `roles` command category and are separate from tournament role tools. Configuration is done in Discord; there is no web dashboard.

## Quick setup

1. Ensure the bot has **Manage Roles**, and move its highest role above every role you plan to offer.
2. Create a draft:
   - `/selfroles create key:community title:Community roles`
3. Add a choice group:
   - `/selfroles group panel:community name:Interests mode:Multiple choices min:0 max:3`
4. Add role options (repeat as needed):
   - `/selfroles role panel:community group:interests role:@Football label:Football duration:permanent`
   - Optional settings include `emoji`, `duration` (`30m`, `12h`, or `7d`), up to four bundled roles, a required role, a blocked role, and an excluded role.
5. Preview, then publish:
   - `/selfroles preview panel:community mode:Buttons and dropdowns`
   - `/selfroles publish panel:community mode:Buttons and dropdowns channel:#roles`

Members click **Choose / update roles** and make changes in a private menu. `/roleprefs` also shows their current self-role choices privately.

## Choice and access rules

- Groups support **single** or **multiple** choice and optional minimum/maximum selections. Select menus page through 25 roles at a time.
- Panel and group required-role rules are any-of gates; blocked roles deny new selections. Option rules can require a role, deny a role, or exclude a role.
- Members may remove choices if they lose an access gate. Selection rules are checked again when a change is submitted.
- A role option can grant up to four bundled roles. A bundle role that a member already held independently is preserved when the option is removed or expires.
- Timed grants last from one minute to 90 days and are removed automatically by the bot’s expiry worker. Timers continue after a panel is paused or deleted.

## Reactions and panel management

- Publish as **Emoji reactions** or **Both** to enable reaction-to-role toggles. Every option needs a unique Unicode or server emoji; reaction panels support up to 20 role options and cannot enforce minimum selections.
- Reaction publishing requires the bot to have **View Channel**, **Read Message History**, **Send Messages**, **Embed Links**, **Add Reactions**, and **Manage Messages** in the target channel. Component panels only need the usual view/send/embed permissions plus **Manage Roles** at the server level.
- `/selfroles clone` makes a new editable draft. `/selfroles audit` configures an optional audit channel. `/selfroles pause`, `/selfroles resume`, and `/selfroles delete` manage a panel’s lifecycle.
- Deleting a panel leaves permanent roles members already have in place; timed grants still expire. Removing a role option or group also leaves existing member roles in place.

Only members with **Manage Roles** can configure panels. Offered roles are rechecked at publish time and when granted; managed roles, roles above the bot, and roles carrying sensitive permissions are rejected.
