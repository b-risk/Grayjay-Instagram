> [!NOTE]
> This plugin works by utilizing [Kittygram instances](https://codeberg.org/irelephant/kittygram), which improves privacy and removes the requirement for login, however that means the plugin is under the same limitations as the instances being used and lots of metadata may not always be available. Direct Instagram support with login could be added in the future but it's unprioritized.

### Grayjay Instagram
This plugin adds support for the platform Instagram, allowing you to use it in Grayjay. 

### Installation
You can install the plugin by scanning this QR code:  
![QR Code](https://raw.githubusercontent.com/b-risk/Grayjay-Instagram/refs/heads/main/Imgs/qr-code.png)

Alternatively, you can add it manually by using this link:
```
grayjay://plugin/https://raw.githubusercontent.com/b-risk/Grayjay-Instagram/main/InstagramConfig.json
```

### Features
- [x] Reels support, videos and shorts
- [x] Posts support with images
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
