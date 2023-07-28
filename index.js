const express = require("express");
const app = express();
const session = require("express-session");
const sequelizeStore = require("connect-session-sequelize")(session.Store);
const passport = require("passport");
const cors = require("cors");
const db = require("./db");
const { User } = require("./db/models");

const store = new sequelizeStore({ db });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  cors({
    origin: "*",
    methods: "GET,PUT,PATCH,HEAD,POST,DELETE",
    credentials: true,
    // allowedHeaders:
    //   "Authorization, X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version",
    preflightContinue: true,
  })
);

app.use(
  session({
    secret: "ticketWingMan_backend",
    store: store,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 3 * 1000 * 60 * 60 },
    httpOnly: true,
  })
);

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    console.log(id)
    const user = await User.findByPk(id);

    done(null, user);
  } catch (err) {
    done(err);
  }
});

app.use(passport.initialize());
app.use(passport.session());

const setupRoutes = () => {
  app.use("/api", require("./api"));
  app.use("/auth", require("./auth"));
  app.get("/", (req, res) => {
    res.send("Hello! This is ticketWingMan backend");
  });
};

const runServer = async (port) => {
  await db.sync();
  app.listen(port, () => {
    console.log(`server is running on port 8080`);
  });
};

const configureApp = async (port) => {
  await store.sync();
  await setupRoutes();
  return await runServer(port);
};

module.exports = configureApp(8080);
