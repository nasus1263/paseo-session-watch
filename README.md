# paseo-session-watch

[한국어](README.ko.md)

A [Paseo](https://paseo.sh) plugin that watches selected agent sessions and shuts down the PC when they all finish. You can chain follow-up tasks, and sessions that hit a usage limit resume on their own.

## Install

```bash
paseo plugin add git:nasus1263/paseo-session-watch
```

Plugins must be enabled on the daemon (**Settings → Plugins → Enable plugins**). Requires a **Windows** daemon and Paseo `>=0.15.4`.

## Usage

1. Open the **세션 감시** screen in the sidebar.
2. Select the sessions to watch.
3. Optionally add follow-up tasks: a message to the same session, or a new session. Each runs after the tasks it depends on finish.
4. Start watching.

When every task is done, it runs `shutdown /s /t 60`.

## Notes

- **It shuts down your PC.** To cancel, click **PC 종료 취소** or run `shutdown /a` within 60 seconds.
- When a session hits a usage limit, the plugin waits until the reset time and sends `continue`. If the reset time is unknown, it checks again every 30 minutes.
- Limit detection matches Claude's reply text (for example, "You've hit your limit"). If the provider changes the wording, detection can miss.
- These end a task as failed: errors, cancellations, and permission waits longer than 30 minutes (configurable). Tasks that depend on a failed task are skipped.
- The plan is saved in `~/.paseo/plugin-data/paseo-session-watch/plan.json` and survives restarts. After a restart, polling resumes once an app connects or an agent event occurs.
