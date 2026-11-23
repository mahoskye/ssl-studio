-- Ad-hoc SQL check for DEMO-103: samples overdue or due inside a 3-day window.
-- Everything here is invented for the Due dates demo.
SELECT
    s.SAMPLE_ID,
    s.PRIORITY,
    s.INSTRUMENT_ID,
    s.DUE_ON,
    CASE
        WHEN s.DUE_ON < @AsOfDate THEN 'DUE_LATE'
        WHEN s.DUE_ON = @AsOfDate THEN 'DUE_TODAY'
        ELSE 'DUE_SOON'
    END AS REPORT_BUCKET
FROM
    DEMO_SAMPLES s
WHERE
    s.DUE_ON IS NOT NULL
    AND s.DUE_ON <= DATEADD(DAY, @WindowDays, @AsOfDate)
ORDER BY
    s.DUE_ON ASC,
    s.SAMPLE_ID ASC;
