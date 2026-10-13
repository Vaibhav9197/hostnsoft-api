-- Orphan claim link: the hash of the one-time claim code an anonymous deploy
-- hands back, so the deployer can keep the app by signing in instead of
-- redeploying with a token. Nullable: orphans created before this column
-- have no code and keep the token path only.
ALTER TABLE "Project" ADD COLUMN "claimCodeHash" TEXT;
