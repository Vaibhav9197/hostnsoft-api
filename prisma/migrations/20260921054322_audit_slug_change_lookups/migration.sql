-- CreateIndex
CREATE INDEX "AuditLog_projectId_action_createdAt_idx" ON "AuditLog"("projectId", "action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_companyId_action_createdAt_idx" ON "AuditLog"("companyId", "action", "createdAt");
