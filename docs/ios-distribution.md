# iOS Distribution (TestFlight)

The native app in `apps/ios` ships to TestFlight through the manually dispatched `.github/workflows/native-ios-release.yml`. Expo has no iOS release path.

## Apple identities

|Item|Value|
|---|---|
|Apple Developer team|Eric Johney, Team ID `27ZLS4MK3J`|
|Account holder Apple ID|`eric@ericjohney.com`|
|Bundle ID / App ID|`com.photobrain.app` (`27ZLS4MK3J.com.photobrain.app`); no extra capabilities|
|App Store Connect app|"PhotoBrain Library", app ID `6819894040`, SKU `photobrain-ios` ("PhotoBrain" is taken globally)|
|Distribution certificate|`Apple Distribution: Eric Johney (27ZLS4MK3J)`, SHA-1 `B6EAE1911511211D276420A918E4C38825D5CFE6`; expires 2027-10-06|
|Provisioning profile|`com.photobrain.app AppStore` (App Store distribution); expires 2027-10-06|
|App Store Connect API key|"PhotoBrain CI", key ID `W9YXQYD3G3`, role App Manager|
|TestFlight internal group|"Me": internal, access to all builds, contains `eric@ericjohney.com`|

Preview (`com.photobrain.app.preview`) and Debug (`com.photobrain.app.debug`) bundles are not registered and have no signing assets; use them only for simulator or Xcode automatic-signing installs.

## Releasing

GitHub → Actions → **Native iOS Production Release** → **Run workflow** on `main`, or:

```bash
gh workflow run native-ios-release.yml --ref main            # marketing version 1.0.0
gh workflow run native-ios-release.yml --ref main -f marketing_version=1.1.0
```

The workflow (on a GitHub-hosted `macos-26` runner with Xcode 26.6):

1. Validates the inputs and secrets (bundle, scheme, iOS 17.0 minimum, non-local HTTPS API URL, ID formats).
2. Allocates a build number above both App Store Connect history and `run_id * 100 + run_attempt` (`apps/ios/scripts/allocate-app-store-build.mjs`).
3. Imports the certificate/profile into a temporary keychain and checks that the profile authorizes that certificate.
4. Archives `PhotoBrain-Production` with manual signing, exports the IPA, and runs `apps/ios/scripts/inspect-signed-artifact.sh`.
5. Retains the archive, dSYMs, and IPA as run artifacts, then uploads to TestFlight with `altool`.

Bump `marketing_version` for a new user-visible version; App Store Connect stops accepting builds for a version once it has been released on the App Store.

## GitHub secrets

|Secret|Contents|
|---|---|
|`IOS_TEAM_ID`|`27ZLS4MK3J`|
|`IOS_APPLICATION_ID`|`27ZLS4MK3J.com.photobrain.app`|
|`IOS_DISTRIBUTION_IDENTITY_SHA1`|Certificate SHA-1 above, no colons|
|`IOS_DISTRIBUTION_CERTIFICATE_BASE64`|Base64 of the `.p12` (certificate + private key)|
|`IOS_DISTRIBUTION_CERTIFICATE_PASSWORD`|`.p12` export password|
|`IOS_PROVISIONING_PROFILE_BASE64`|Base64 of the App Store `.mobileprovision`|
|`ASC_APP_ID`|`6819894040`|
|`ASC_KEY_ID`|`W9YXQYD3G3`|
|`ASC_ISSUER_ID`|App Store Connect → Users and Access → Integrations → App Store Connect API (shown above the key table)|
|`ASC_PRIVATE_KEY`|Contents of `AuthKey_W9YXQYD3G3.p8`|

Local copies of the signing material live in `~/.photobrain-signing/` on Eric's Mac (mode 700): the certificate, its private key, the `.p12` and its password, the profile, and the `.p8` key. Nothing signing-related is committed to the repository.

## Renewing the certificate and profile (before 2027-10-06)

Both expire together. Installed TestFlight builds keep working until their own 90-day TestFlight expiry, but new releases fail at the signing step once either is expired.

fastlane must run outside `CI=true` and with full Xcode selected:

```bash
cd ~/.photobrain-signing
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
env -u CI fastlane cert --username eric@ericjohney.com --platform ios --output_path .
env -u CI fastlane sigh --username eric@ericjohney.com --app_identifier com.photobrain.app \
  --platform ios --cert_id <NEW_CERT_ID> --output_path . \
  --filename PhotoBrain_AppStore.mobileprovision --skip_install --force
```

`fastlane cert` writes `<ID>.cer` and the PEM private key as `<ID>.p12`. Despite the extension, that file is not PKCS#12. Build the real `.p12`, then update the secrets:

```bash
openssl x509 -inform DER -in <ID>.cer -out dist.pem
openssl pkcs12 -export -inkey <ID>.p12 -in dist.pem -out distribution.p12 -passout pass:<PASSWORD>
openssl x509 -in dist.pem -noout -fingerprint -sha1   # new IOS_DISTRIBUTION_IDENTITY_SHA1 (strip colons)
base64 -i distribution.p12 | gh secret set IOS_DISTRIBUTION_CERTIFICATE_BASE64
printf '%s' '<PASSWORD>' | gh secret set IOS_DISTRIBUTION_CERTIFICATE_PASSWORD
base64 -i PhotoBrain_AppStore.mobileprovision | gh secret set IOS_PROVISIONING_PROFILE_BASE64
printf '%s' '<SHA1>' | gh secret set IOS_DISTRIBUTION_IDENTITY_SHA1
```

Revoke the old certificate in Certificates, IDs & Profiles once a release with the new one succeeds. An Apple team allows a limited number of distribution certificates.

## Rotating the API key

API keys do not expire. If the `.p8` leaks, revoke "PhotoBrain CI" in App Store Connect → Users and Access → Integrations, generate a replacement (App Manager role), and update `ASC_KEY_ID` and `ASC_PRIVATE_KEY`.

## Testers

Internal testers must be users on the App Store Connect team. Add one to the "Me" group (or a new internal group) under App Store Connect → PhotoBrain Library → TestFlight. External testers need Beta App Review and should wait for API authentication: every TestFlight build talks to the public, unauthenticated `https://photobrain-api.ericj5.com`.
