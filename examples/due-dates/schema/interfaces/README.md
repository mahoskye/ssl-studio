# Interfaces

What the project exchanges with instruments and other systems: one Markdown file for each message, with its fields. A sample of the message, or its own schema (JSON, XML, YAML), can lie beside it.

| Message | From | What it is for |
| --- | --- | --- |
| [Outage notice](Outage-notice.md) | Maintenance system | Says an instrument will be out |

Nothing in `src/` reads a message yet. The one here is described so that the script that will can be written against it.
