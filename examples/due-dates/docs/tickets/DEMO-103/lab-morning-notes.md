# Lab morning standup notes

Notes gathered while refining the morning due-soon list (all details invented
for this demo).

## Late-sample wording

- Overdue samples should appear at the top of the morning list before samples
  due today, ordered oldest due date first.
- Keep the existing `DUE_TODAY`, `DUE_NEXT_DAY`, and `DUE_SOON` labels intact,
  and add `DUE_LATE` when `DUE_ON < dAsOf`.

| Status | Rule |
| --- | --- |
| `DUE_LATE` | `DUE_ON < dAsOf` |
| `DUE_TODAY` | `DUE_ON = dAsOf` |
| `DUE_NEXT_DAY` | Next working day after `dAsOf` |
| `DUE_SOON` | Later inside the look-ahead window |

## Draft SSL status branch

Sketch for extending `DueSoonReport` (use **Format** above the block to format
through `starlims-lsp`):

```ssl
:PROCEDURE DueStatus;
	:PARAMETERS dDue, dAsOf, dNextWorking;
	:BEGINCASE;
		:CASE dDue < dAsOf;
			:RETURN "DUE_LATE";
		:CASE dDue = dAsOf;
			:RETURN "DUE_TODAY";
		:CASE dDue = dNextWorking;
			:RETURN "DUE_NEXT_DAY";
		:OTHERWISE;
			:RETURN "DUE_SOON";
	:ENDCASE;
:ENDPROC;
```

## Quick SQL verification query

```sql
SELECT
    SAMPLE_ID,
    PRIORITY,
    INSTRUMENT_ID,
    DUE_ON
FROM
    DEMO_SAMPLES
WHERE
    DUE_ON IS NOT NULL
    AND DUE_ON <= DATEADD(DAY, 3, CAST(GETDATE() AS DATE))
ORDER BY
    DUE_ON ASC,
    SAMPLE_ID ASC;
```
