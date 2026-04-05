-- Custom SQL migration file, put your code below! --
ALTER TABLE "credentials" RENAME COLUMN "value_encrypted" TO "value_plaintext";