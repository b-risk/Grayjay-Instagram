> [!NOTE]
> The `allowAllHttpHeaderAccess` permission is currently required to read tbe `Set-Cookie` headers.

### Grayjay Instagram
This plugin adds support for the platform Instagram, allowing you to use it in Grayjay. 
The plugin works by utilizing [Kittygram](https://codeberg.org/irelephant/kittygram) instances, which improves privacy and doesn't require you to login, at the cost of having the same limitations as Kittygram and thus doesn't have complete metadata parity with the original site.

### Installation
You can install the plugin by scanning this QR code:  
![QR Code](https://raw.githubusercontent.com/b-risk/Grayjay-Instagram/refs/heads/main/Imgs/qr-code.png)

Alternatively, you can add it manually by using this link:
```
grayjay://plugin/https://raw.githubusercontent.com/b-risk/Grayjay-Instagram/main/InstagramConfig.json
```

### Features
- [x] Reels supported as video shorts
- [x] Posts support (PlatformPosts)
- [x] Comments support
- [x] User profiles support as individual channels
- [x] Channel feeds with reels & posts
- [x] Search channel content support
- [x] Search channels support
- [x] Set prioritized Kittygram instance, automatically falls back to other instances when one is down

### Contributions
Contributions are welcome, feel free to submit pull requests if you think you can improve something or fix a bug.

### Signing
```bash
# Generate keypair
ssh-keygen -t rsa -b 2048 -m PEM -f ./Signatures/private-key.pem

# Encode it in Base64 and set the environment variable
export SIGNING_PRIVATE_KEY="$(base64 -w 0 ./Signatures/private-key.pem)"

# Run the sign script (use git bash on Windows):
sh ./sign-script.sh ./Signatures/InstagramScript.js ./Signatures/InstagramConfig.json
```
