# Gorilla VR: full version with public multiplayer

Everything in one package: gorilla movement, bendy-arm avatars, LIV camera tablet,
5 maps (including a blank one), the VR map builder, and online multiplayer.
Anyone with the link can play together. No accounts needed for players.

## Put it online (free, works from a phone)
1. Make a free account at github.com. Create a new PUBLIC repository named `gorilla-vr`.
2. Upload `server.js`, `package.json` and `README.md`.
3. Make the page: tap Add file > Create new file, type `public/index.html` as the name
   (typing the slash makes the folder), paste in the contents of `public/index.html`, and commit.
4. Make a free account at render.com (sign up with GitHub).
   New > Web Service > pick your `gorilla-vr` repo.
   Build Command: `npm install`    Start Command: `npm start`    Instance type: Free
5. When Render says Live, open your `https://....onrender.com` link in the Meta Quest Browser.
   Share the same link with friends.

## How multiplayer works
- Everyone sees each other's head, body and arms. Colors come from each player's swatch choice.
- Everyone is on the same map. Changing the map changes it for all players.
- Blocks built in VR appear for everyone. You can delete or undo only YOUR OWN blocks.
- The server remembers maps and blocks only while it is running. The free Render plan
  sleeps after ~15 minutes with nobody online, and built blocks are lost when it does.
  Use Export in the menu to save a map code you can paste back later.
- Up to 24 players at once, 300 blocks per map.
- The camera tablet is private to each player (it is not shown to others).

## Controls in VR
Press B (right) or Y (left) to build. Right trigger place, right A delete, left X undo,
right stick: size / material, left stick click: next map.

## Test on your own computer
    npm install
    npm start
Open http://localhost:3000. (WebXR on the Quest needs https, so deploy it to test in the headset.)
