# Synthetic user-testing fixture

**Not real sessions.** Invented records and issues that exercise every branch of
`scripts/user_testing_report.ts` (assisted, failed, skipped, no-show, partial,
untriaged issue). Run with `npx tsx scripts/user_testing_report.ts --fixture`.
The output is stamped as synthetic and the script never writes it to the report.
Issue numbers are 9xxx and their URLs point at `example.invalid`.
