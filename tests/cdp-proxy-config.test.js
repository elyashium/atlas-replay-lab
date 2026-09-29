import test from "node:test";
import assert from "node:assert/strict";
import { egressProxyChromeArgs } from "../src/runner/cdp.js";

test("worker proxy config forces numeric HTTP proxy and disables common bypass transports", () => {
  assert.deepEqual(egressProxyChromeArgs("http://172.28.0.3:3128"), [
    "--proxy-server=http://172.28.0.3:3128",
    "--proxy-bypass-list=<-loopback>",
    "--disable-setuid-sandbox",
    "--disable-quic",
    "--disable-features=DnsOverHttps",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ]);
});

test("worker proxy config fails closed on hostnames, credentials, paths and non-HTTP schemes", () => {
  for (const value of [
    "https://172.28.0.3:3128",
    "http://proxy.internal:3128",
    "http://user:pass@172.28.0.3:3128",
    "http://172.28.0.3:3128/path",
    "http://172.28.0.3",
  ]) {
    assert.throws(() => egressProxyChromeArgs(value), /ATLAS_EGRESS_PROXY/);
  }
});
