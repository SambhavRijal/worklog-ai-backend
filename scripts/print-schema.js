// print-schema.js — dump the schema DDL for pasting into a SQL console.
// Useful when you'd rather create tables in Supabase's SQL Editor than run init-db.
//   node scripts/print-schema.js > schema.sql
// Prints only; connects to nothing.
import { SCHEMA_SQL } from '../src/db.js';
console.log(SCHEMA_SQL.trim());
