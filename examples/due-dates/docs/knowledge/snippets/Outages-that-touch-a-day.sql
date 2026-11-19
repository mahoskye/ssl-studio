-- Outages that touch a day
-- Which instruments are out of service on a given day. Change the date.

SELECT INSTRUMENT_ID, FROM_ON, TO_ON, REASON
FROM DEMO_OUTAGES
WHERE FROM_ON <= '2026-12-01'
  AND TO_ON >= '2026-12-01'
ORDER BY INSTRUMENT_ID;
