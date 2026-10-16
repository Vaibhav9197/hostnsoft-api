/**
 * Periodic re-check of every already-active custom domain's DNS — see
 * docs/Customdomain-req.md constraint #3: verification at claim time
 * isn't enough, since a domain's DNS can be repointed elsewhere later
 * while this platform's router/cert config for it silently stays active.
 * A domain that no longer resolves here gets deactivated: its router is
 * torn down and its certificate stops being renewed.
 */
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { verifyDomainDns } from "../lib/dnsVerify";
import type { DomainType } from "../lib/customDomain";
import { deactivateDomain } from "./customDomainActivation";
import { DOMAIN_REVERIFICATION_INTERVAL_MS } from "../lib/customDomainConfig";

async function reverifyAllActiveDomains(): Promise<void> {
  const activeDomains = await prisma.domain.findMany({ where: { status: "active" } });

  for (const domain of activeDomains) {
    const stillOk = await verifyDomainDns(domain.domain, domain.type as DomainType);

    if (stillOk) {
      await prisma.domain.update({ where: { id: domain.id }, data: { lastVerifiedAt: new Date() } });
      continue;
    }

    logger.warn(
      `[domainReverification] "${domain.domain}" no longer resolves to the platform — deactivating`
    );
    await deactivateDomain(domain.id);
  }
}

export function startDomainReverificationLoop(): void {
  setInterval(() => {
    reverifyAllActiveDomains().catch((e) => {
      logger.error(`[domainReverification] loop iteration failed: ${(e as Error).message}`);
    });
  }, DOMAIN_REVERIFICATION_INTERVAL_MS).unref(); // .unref(): don't keep the process alive on shutdown
}
