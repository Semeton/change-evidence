"use strict";
module.exports = {
  ...require("./study"),
  ...require("./risk"),
  history: require("./history"),
  extractors: {
    routes: require("./extractors/routes"),
    migrations: require("./extractors/migrations"),
    dependencies: require("./extractors/dependencies"),
    workflows: require("./extractors/workflows"),
  },
};
