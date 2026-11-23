-- Check PostgreSQL version
SELECT version();

-- Create a database
CREATE DATABASE my_first_database;

-- List databases
SELECT datname
FROM pg_database;