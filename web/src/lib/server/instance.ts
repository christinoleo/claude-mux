import { randomUUID } from 'node:crypto';

/**
 * Who this server process is, for telling machines apart on the tailnet.
 *
 * One machine can answer under several tailnet names — a Windows host that
 * forwards the port into its WSL is both `asuslaptop` and `asuslaptop-wsl` —
 * and discovery would list it twice. Every answer to /api/health carries
 * this id, minted once per process, so two names that lead to the same
 * process are recognised as one machine. It changes on restart, which is
 * fine: discovery asks live.
 */
export const INSTANCE_ID = randomUUID();
