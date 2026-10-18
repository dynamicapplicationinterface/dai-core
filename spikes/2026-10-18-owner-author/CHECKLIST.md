# Phone checklist: experiments C and D

Probe: **https://dai-spike-owner.opendai.workers.dev/**

Its own Worker (`dai-spike-owner`) and its own Durable Object. It shares
nothing with the relay or the store. It will be deleted after the readings
are recorded.

Every step that says **Copy readings** means: tap *Copy readings* at the
bottom of the page and paste the whole text back, exactly as it is. Answer
the yes/no questions in your own words.

Before starting, note: Settings › General › About › **iOS Version**.

## 1. Safari: make the owner, write the first row

1. Open the probe URL in Safari. The page should say *Running as: Safari
   tab*. Note the **author id** (call it S1).
2. The keychain secret: done in the first pass. Safari saved it and filled
   it back (fingerprint `4fbcb44beb3c75bd`). Do not make another one. Fill
   it from Passwords (lower field, then **Use this secret**). Check that the
   fingerprint reads the same.
   - **Q1.** Did Safari offer to save the password when you made it? (Yes,
     going by the first pass. Confirm.)
3. The owner passkey:
   - If the first pass made one, tap **Sign in with passkey**.
   - If not, tap **Create owner passkey** and save the passkey, then tap
     **Sign in with passkey** once.

   Either way, the sign-in reads PRF the way every later sign-in does.
   - **Q1b.** Did the first pass make a passkey? Check Settings ›
     Passwords for `opendai.workers.dev`, and say how many passkeys it
     lists.
4. Tap **Write a row** with `Safari 1b`. The `Safari 1` row from the first
   pass uploads with it.
5. **Copy readings** (R1).

## 2. Home Screen app: a second author, same owner

1. In Safari, tap Share › **Add to Home Screen** › Add. Open the new icon.
   The page should say *Running as: Home Screen app*.
   - **Q2.** Is the author id different from S1? Note it as A1.
2. Tap **Sign in with passkey**. Approve with Face ID.
   - **Q3.** Was the passkey from step 1 offered?
3. Tap **Restore latest**. The *last restore* line shows `prf: unwrapped`
   or `prf: unwrap FAILED`. This shows whether the app derives the same PRF
   secret as Safari.
4. Under *Keychain secret*, tap the **lower** password field ("Tap, then
   fill from Passwords"). Pick the saved `dai-spike-wrap` password (Face
   ID), then tap **Use this secret**.
   - **Q4.** Did the app offer the saved password?
5. Write a row `App 1`.
6. **Copy readings** (R2).

## 3. Safari: the last write before the wipe

1. Switch back to the Safari tab. Tap **Sign in with passkey**.
2. If the *Keychain secret fingerprint* reads `none`, fill it from Passwords
   as in 2.4.
3. Write a row `Safari 2`. The page should say *Uploaded revision 3 (paths:
   prf, keychain, store)*. Note the paths it lists.
4. **Copy readings** (R3).

## 4. The wipe

1. Close the probe's Safari tab.
2. Open Settings › Apps › Safari › Advanced › **Website Data**. Find
   `opendai.workers.dev` and delete it. Do not delete the Home Screen icon.
   - **Q5.** Which entry did you delete? Write its name exactly as shown.

## 5. Safari again: restore through the owner

1. Open the probe URL from the link, not from history. Expect a new author
   id (S2), *Not signed in*, and no rows.
2. Tap **Sign in with passkey** (Face ID). Do not fill the keychain secret
   yet.
3. Tap **Restore latest**. On the *last restore* line, read the `prf`
   result. `keychain` should say `no secret in this context`.
4. Fill the keychain secret from Passwords (lower field, then **Use this
   secret**), and tap **Restore latest** again. Read the `keychain` result.
   - **Q6.** Was the saved password offered after the wipe?
5. Confirm the table shows `Safari 1`, `App 1` and `Safari 2`, with the
   author ids S1, A1, S1.
6. **Copy readings** (R4).

## 6. Home Screen app again

1. Open the Home Screen icon.
   - **Q7.** Is its author id still A1? If not, the Safari wipe reached the
     installed app's storage too.
2. **Copy readings** (R5).

## 7. No passkey

1. In Safari, tap **Sign in with passkey**, and **cancel** the sheet.
   - **Q8.** What does the page say? Copy its words.
2. Tap **Save a copy**.
   - **Q9.** What happened (a download sheet, a file in Files, or nothing)?
3. **Copy readings** (R6).

## Send back

- the iOS version
- Q1–Q9
- R1–R6, verbatim
