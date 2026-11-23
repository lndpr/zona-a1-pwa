-- Jalankan sekali di D1 produksi:
-- npx wrangler d1 execute zona-a1-signals --remote --file=./migration-profit.sql
ALTER TABLE signals ADD COLUMN profit REAL;
