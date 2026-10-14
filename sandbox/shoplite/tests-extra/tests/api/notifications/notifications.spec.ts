import { test, expect } from "../../../src/fixtures";

test.describe("POST /notifications", () => {
  test("queues an email notification @service:notifications-service @endpoint:POST_/notifications", async ({ api, data }) => {
    const res = await api.post("/notifications", { orderId: data.unique("ord"), channel: "email", message: "hello" });
    expect(res.status()).toBe(202);
    const body = await res.json();
    expect(body.status).toBe("queued");
    expect(body.channel).toBe("email");
  });

  test("returns 400 for an unknown channel @service:notifications-service @endpoint:POST_/notifications", async ({ api, data }) => {
    const res = await api.post("/notifications", { orderId: data.unique("ord"), channel: "pigeon", message: "hello" });
    expect(res.status()).toBe(400);
  });
});

test.describe("GET /notifications", () => {
  test("filters by orderId @service:notifications-service @endpoint:GET_/notifications", async ({ api, data }) => {
    const orderId = data.unique("ord");
    await api.post("/notifications", { orderId, channel: "sms", message: "a" });
    const res = await api.get("/notifications", { params: { orderId } });
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(list).toHaveLength(1);
    expect(list[0].orderId).toBe(orderId);
  });
});
