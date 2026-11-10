/**
 * Values this package pins in its own code instead of trusting the server. A Recta server that served other values
 * (a compromised deploy, a man in the middle, a wrong origin) makes every call refuse before anything is signed: moving
 * the fee anywhere else would need a new release of this package as well.
 *
 * Every value is checked equal to the Recta server's own configuration by a test in the Recta repository.
 */

export const RECTA_ORIGIN = "https://api.recta.build";

/** This package's version (equal to package.json, checked in CI). */
export const CLIENT_VERSION = "0.1.6";
/** Sent on every request so Recta can count real use of this package apart from other clients (no address, no key). */
export const USER_AGENT = `recta-client/${CLIENT_VERSION}`;

/** The fee: x402 `upto` on Base, a Permit2 `permitWitnessTransferFrom`. All lowercase. */
export const FEE_CHAIN_ID = 8453;
export const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
export const UPTO_PROXY = "0x4020a4f3b7b90cca423b9fabcc0ce57c6c240002";
export const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
/** The only address a Recta fee can pay (`witness.to`). */
export const FEE_RECEIVER = "0xae866c10e0f2d942da3cddddda082feb65faf108";
/** The only address that can settle a Recta fee permit (`witness.facilitator`). */
export const FEE_FACILITATOR = "0x993a2a880d20eae16dc65fec374dcadabef1098a";
/** A permit may stay valid at most this long after its decision's commercial expiry (37 days). */
export const PERMIT_DEADLINE_AFTER_EXPIRY_SECONDS = 37n * 86_400n;

export const FEE_PERMIT_TYPES = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Witness: [
    { name: "to", type: "address" },
    { name: "facilitator", type: "address" },
    { name: "validAfter", type: "uint256" },
  ],
} as const;

/** Signed requests from this package: an EOA signs v1 (EIP-191 `personal_sign`); a smart account signs v2, which also
 *  names the signer and the chain, with the signer-chain header (checked by the account on Base: ERC-1271 / ERC-6492). */
export const SIGNED_REQUEST_PREFIX = "Recta signed request v1";
export const SMART_ACCOUNT_SIGNED_REQUEST_PREFIX = "Recta signed request v2";
export const SIGNER_CHAIN_HEADER = "x-recta-signer-chain";
export const SIGNER_HEADER = "x-recta-signer";
export const ISSUED_AT_HEADER = "x-recta-issued-at";
export const SIGNATURE_HEADER = "x-recta-signature";

export const PATHS = {
  evaluations: "/v1/golden-corridor/commercial-evaluations",
  accruals: "/v1/golden-corridor/commercial-accruals/",
  feeDebts: "/v1/golden-corridor/fee-debts",
  walletPolicy: "/v1/golden-corridor/wallet-policy",
} as const;

export const WALLET_POLICY_SCHEMA = "RECTA_AGENT_WALLET_POLICY_V1";
export const EXECUTION_ARTIFACT_SCHEMA = "RECTA_COMMERCIAL_EXECUTION_ARTIFACT_V2";
