// MemoryStore against the shared Store contract. This file imports the store directly, which the
// route tests never do: the Store interface has no HTTP surface of its own, and the contract
// suite uses the real implementation with real values and no stand-ins.
import { MemoryStore } from "../src/store/memory";
import { runStoreContract } from "./helpers/store-contract";

runStoreContract("MemoryStore", () => new MemoryStore());
