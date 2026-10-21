import cors from "cors";
import {
  defineServer,
  defineRoom,
  monitor,
  playground,
} from "colyseus";

import { LobbyRoom } from "./rooms/LobbyRoom.js";

const server = defineServer({
  rooms: {
    // One room per world: a join's `world` option (client src/config.js WORLD) only ever
    // matches a room created for the same world, so the lobby and the Ice World each see
    // just their own players.
    lobby: defineRoom(LobbyRoom).filterBy(["world"]),
  },

  express: (app) => {
    // Readiness/liveness probe required by Bloxity Legion.
    app.get("/health", (_req, res) => {
      res.sendStatus(200);
    });

    // Bloxity injects CLIENT_ORIGIN in deployed environments; wildcard
    // remains for local dev where the var isn't set.
    app.use(cors({
      origin: process.env.CLIENT_ORIGIN || "*",
    }));

    // Dev-only tooling -- never expose in production.
    if (process.env.NODE_ENV !== "production") {
      app.use("/monitor", monitor());
      app.use("/", playground());
    }
  }
});

export default server;
