-- What a deploy token may reach: "workspace" (its own workspace's apps, the
-- behaviour every token had until now) or "user" (whatever its creator can
-- reach, checked live). See schema.prisma's DeployToken comment.
ALTER TABLE "DeployToken" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'workspace';

-- Agent ("agent", the public email endpoint) and connector tokens were always
-- minted for one signed-in person, so they become that person's. Dashboard
-- tokens stay workspace tokens: some of them sit in CI, and turning those
-- into a person's would make a pipeline stop the day that person leaves.
-- The "system:" guard covers email tokens minted before the endpoint
-- recorded a user (createdBy "system:public-token-api"): a user token needs
-- a real user to act as, so those keep the workspace behaviour.
UPDATE "DeployToken"
SET "kind" = 'user'
WHERE "source" IN ('agent', 'connector')
  AND "createdBy" NOT LIKE 'system:%';
