-- DATABASE fixture for the sample module. Neutral identifiers only; written for
-- the sample, not reconstructed from any export.
create table SAMPLE_EQUIPMENT (EQUIPMENT_ID text, DESCRIPTION text, STATUS text, INTERVAL_DAYS integer, LAST_CALIBRATED date);
create table SAMPLE_CALIBRATION (CALIBRATION_ID integer, EQUIPMENT_ID text, CALIBRATED_ON date, READING real, RESULT text, CALIBRATED_BY text);
create table SAMPLE_UNITS (UNIT_CODE text, UNIT_NAME text, UNIT_TYPE text);
create table SAMPLE_STATUS (STATUS_CODE text, STATUS_NAME text);
create table LIMSCOUNTERS (TABLNAME text, FLDNAME text, PREFIX text, LIMSCOUNTER integer);
insert into LIMSCOUNTERS (TABLNAME, FLDNAME, PREFIX, LIMSCOUNTER) values ('SAMPLE_CALIBRATION', 'CALIBRATION_ID', NULL, 100);
insert into SAMPLE_EQUIPMENT values ('BAL-01', 'Analytical balance', 'A', 365, '2026-01-15');
insert into SAMPLE_EQUIPMENT values ('PH-02', 'pH meter', 'A', 90, '2026-10-01');
insert into SAMPLE_EQUIPMENT values ('OV-03', 'Drying oven', 'I', 180, NULL);
insert into SAMPLE_EQUIPMENT values ('TH-04', 'Thermometer', 'A', 30, '2026-10-20');
insert into SAMPLE_EQUIPMENT values ('SC-05', 'Bench scale', 'A', 180, '2026-05-01');
insert into SAMPLE_EQUIPMENT values ('MC-06', 'Micropipette', 'A', 30, '2026-10-15');
insert into SAMPLE_UNITS values ('mm', 'millimetre', 'LENGTH');
insert into SAMPLE_UNITS values ('m', 'metre', 'LENGTH');
insert into SAMPLE_UNITS values ('g', 'gram', 'MASS');
insert into SAMPLE_STATUS values ('A', 'Active');
insert into SAMPLE_STATUS values ('I', 'Inactive');
