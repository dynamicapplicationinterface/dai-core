import { expect, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { RUNNER_URL } from "./owner.js";

/**
 * What the keychain and restore specs share (Build 2b-2b): a password manager
 * as a test reads one, and a browser wiped to nothing but its passkey.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export interface Handed {
  owner: string;
  secret: string;
  by: "credential management" | "form";
}

/**
 * Records what the opener hands a password manager, by either path, across
 * the page's reloads, and hands it on. `asSafari` takes the Credential
 * Management API away, as Safari has none; `refuse` makes the browser refuse
 * every store, so nothing is ever kept in a keychain.
 */
export async function watchKeychain(context: BrowserContext, how: { asSafari?: boolean; refuse?: boolean } = {}): Promise<Handed[]> {
  const handed: Handed[] = [];
  await context.exposeBinding("__keychainHanded", (_source, entry: Handed) => {
    handed.push(entry);
  });
  await context.addInitScript((options: { asSafari?: boolean; refuse?: boolean }) => {
    const report = (entry: unknown): void => void (window as Any).__keychainHanded?.(entry);
    if (options.asSafari) delete (window as Any).PasswordCredential;
    const store = navigator.credentials?.store?.bind(navigator.credentials);
    if (store) {
      navigator.credentials.store = (credential: Any) => {
        if (options.refuse) return Promise.reject(new DOMException("refused", "NotAllowedError"));
        if (credential && typeof credential.password === "string") report({ owner: credential.id, secret: credential.password, by: "credential management" });
        return store(credential);
      };
    }
    const submit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
      const password = this.querySelector<HTMLInputElement>('input[type="password"]');
      const username = this.querySelector<HTMLInputElement>('input[autocomplete="username"]');
      if (password?.value && !options.refuse) report({ owner: username?.value ?? "", secret: password.value, by: "form" });
      return submit.call(this);
    };
  }, how);
  return handed;
}

/** Wipes everything this origin keeps: storage, databases, the worker and its caches. The passkey is the authenticator's. */
export async function wipe(page: Page, cdp: CDPSession): Promise<void> {
  await cdp.send("Storage.clearDataForOrigin", { origin: new URL(RUNNER_URL).origin, storageTypes: "all" });
  await page.goto(RUNNER_URL);
  expect(await page.evaluate(() => (window as Any).__runner.listLibrary()), "nothing is left").toEqual([]);
}
