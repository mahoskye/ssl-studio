-- Samples due in a window
-- What the report of samples due soon reads. Change the two dates.

SELECT SAMPLE_ID, PRIORITY, INSTRUMENT_ID, RECEIVED_ON, DUE_ON, TURNAROUND_DAYS
FROM DEMO_SAMPLES
WHERE DUE_ON >= '2026-11-19'
  AND DUE_ON <= '2026-11-22'
ORDER BY DUE_ON, SAMPLE_ID;
