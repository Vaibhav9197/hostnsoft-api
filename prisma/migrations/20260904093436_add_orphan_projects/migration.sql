-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "memoryMb" INTEGER NOT NULL DEFAULT 256,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isOrphan" BOOLEAN NOT NULL DEFAULT false,
    "orphanExpiresAt" DATETIME,
    CONSTRAINT "Project_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Project" ("companyId", "createdAt", "id", "memoryMb", "name", "slug") SELECT "companyId", "createdAt", "id", "memoryMb", "name", "slug" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
