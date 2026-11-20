-- Samples with no due date
-- The samples the due-date job will look at next. Read only.

SELECT SAMPLE_ID, RECEIVED_ON, PRIORITY, TURNAROUND_DAYS, INSTRUMENT_ID
FROM DEMO_SAMPLES
WHERE DUE_ON IS NULL
ORDER BY RECEIVED_ON, SAMPLE_ID;
