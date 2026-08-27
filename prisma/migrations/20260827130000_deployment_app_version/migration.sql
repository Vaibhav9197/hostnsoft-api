-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Deployment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "appVersion" TEXT NOT NULL,
    "imageTag" TEXT,
    "memoryMb" INTEGER,
    "status" TEXT NOT NULL,
    "errorDetail" TEXT,
    "triggeredBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "Deployment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Deployment" ("createdAt", "errorDetail", "finishedAt", "id", "imageTag", "memoryMb", "projectId", "status", "triggeredBy", "version") SELECT "createdAt", "errorDetail", "finishedAt", "id", "imageTag", "memoryMb", "projectId", "status", "triggeredBy", "version" FROM "Deployment";
DROP TABLE "Deployment";
ALTER TABLE "new_Deployment" RENAME TO "Deployment";
CREATE UNIQUE INDEX "Deployment_projectId_version_key" ON "Deployment"("projectId", "version");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

