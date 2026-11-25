# Knowledge base

What the project has learned: decisions, questions, snippets and prompts kept for use, and notes on how things work.

The list between the two markers is written by SSL Studio from the files here (Docs panel, Update catalogs). Write anything else you like around it.

<!-- catalog -->

### Decisions

- [A walk looks at most 730 days ahead](decisions/0001-A-walk-looks-at-most-730-days-ahead.md): accepted. Decision 5 in Decisions, kept here as a file of its own.
- [Planning and saving are two scripts](decisions/0002-Planning-and-saving-are-two-scripts.md): accepted. Decision 10 in Decisions, kept here as a file of its own.

### Questions

- [Does rush work count Sunday?](questions/Does-rush-work-count-Sunday.md): answered. The ticket says rush work counts Saturday.
- [Which holidays does each site keep?](questions/Which-holidays-does-each-site-keep.md): open. The holidays table has a date and a name, and no site.

### Snippets

- [Outages that touch a day](snippets/Outages-that-touch-a-day.sql): Which instruments are out of service on a given day. Change the date.
- [Samples due in a window](snippets/Samples-due-in-a-window.sql): What the report of samples due soon reads. Change the two dates.
- [Samples with no due date](snippets/Samples-with-no-due-date.sql): The samples the due-date job will look at next. Read only.

### Prompts

- [Cases a rule needs](prompts/Cases-a-rule-needs.md): List the cases a test of the selected due-date rule should cover.
- [Walk through a due date](prompts/Walk-through-a-due-date.md): Walk through how the selected code works out a due date, one step for each day it looks at.

### Reference

- [How a due date is counted](reference/How-a-due-date-is-counted.md): The rule in words, for someone who has not read the scripts.

<!-- /catalog -->
