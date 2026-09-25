import type { Observation } from "../snapshot";
import { instant, numeric, object, observe, type Provider, type Reading } from "./shared";

export function parseDevin(value: unknown, at: number): Observation {
  const status = object(object(object(value).userStatus).planStatus);
  const readings: Reading[] = [];
  for (const [id, label, minutes] of [
    ["daily", "Daily", 1440],
    ["weekly", "Weekly", 10080],
  ] as const) {
    const remaining = numeric(status[`${id}QuotaRemainingPercent`]);
    const resetAt = instant(status[`${id}QuotaResetAtUnix`]);
    if (remaining === null && resetAt === null) continue;
    readings.push({
      id,
      label,
      minutes,
      usedPercent: remaining === null || remaining > 100 ? null : 100 - remaining,
      resetAt,
    });
  }
  if (!readings.length) throw new Error("invalid quota");
  return observe(at, readings);
}

export const devin: Provider = {
  async read({ call }) {
    const payload = await call({
      method: "POST",
      url: "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus",
      header: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
      data: JSON.stringify({
        metadata: {
          ideName: "chisel",
          ideVersion: "3000.10.21",
          apiKey: "$TOKEN$",
          locale: "en",
          os: "darwin",
          extensionVersion: "3000.10.21",
          clientName: "chisel",
        },
      }),
    });
    return { observation: parseDevin(payload, Date.now()) };
  },
};
