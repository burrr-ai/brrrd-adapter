import { modifyConfig } from "./config.js";
import { onBuildComplete } from "./build.js";

const adapter = {
  name: "@brrrd/adapter",
  modifyConfig,
  onBuildComplete,
};

export default adapter;
