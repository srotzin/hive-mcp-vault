# hive-mcp-vault — SUSPENDED

[![srotzin/hive-mcp-vault MCP server](https://glama.ai/mcp/servers/srotzin/hive-mcp-vault/badges/score.svg)](https://glama.ai/mcp/servers/srotzin/hive-mcp-vault)

> **This service has been suspended as of 2026-04-29.**

hive-mcp-vault (srv-d7nqftosfn5c73e9089g) operated TSS-MPC key splitting and ZK biometric commitments.
After partner doctrine review, key custody sits in OKX, Trust Wallet, and MetaMask territory.
Hive does not compete with wallet incumbents.

## Partner-shaped alternatives

**For guardian trust attestations:**
→ [`hive-trust-bond`](https://github.com/srotzin/hive-trust-bond) — staked guardian agents attest
trust scores and post bonds on behalf of principals. Wallets keep custody; Hive attests guardian
credibility. Doctrine-clean.

**For identity passthrough and agent KYC:**
→ [`hive-mcp-agent-kyc`](https://github.com/srotzin/hive-mcp-agent-kyc) — $50 KYC + $20/mo
subscription. DID-anchored identity passthrough for agents operating across settlement rails.
No key custody. No biometric commitment. Identity, not wallet.

## What Hive does instead

Hive provides the trust layer that sits on top of custody-layer wallets:
- Trust scores for agent DIDs (HiveTrust)
- AML attestations (hive-mcp-aml-screen)
- Spectral-signed receipts on every settlement action
- Guardian staking and bond posting (hive-trust-bond)

The wallet keeps the keys. Hive keeps the trust graph.

## Brand

Hive Civilization · brand gold `#C08D23` (never `#f5c518`) · Steve Rotzin

---

*Committed: `chore(deprecate): vault suspended per partner doctrine — see hive-trust-bond + hive-mcp-agent-kyc for partner-shaped alternatives`*

## Hive Civilization Directory

Part of the Hive Civilization — agent-native financial infrastructure.

- Endpoint Directory: https://thehiveryiq.com
- Live Leaderboard: https://hive-a2amev.onrender.com/leaderboard
- Revenue Dashboard: https://hivemine-dashboard.onrender.com
- Other MCP Servers: https://github.com/srotzin?tab=repositories&q=hive-mcp

Brand: #C08D23
<!-- /hive-footer -->
