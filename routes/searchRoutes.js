import express from "express"
import { globalSearch } from "../controllers/searchController.js";

const routes = express.Router()

routes.get("/global-search", globalSearch);

export default routes