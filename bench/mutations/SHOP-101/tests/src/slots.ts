/** A future delivery slot nobody else uses: each test gets its own, so the 3-orders-per-slot limit never leaks between tests. */
export const freshSlot = () => new Date(Date.now() + 86_400_000 + Math.floor(Math.random() * 1e9)).toISOString();
