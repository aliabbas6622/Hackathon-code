import { Router, type IRouter } from "express";
import healthRouter from "./health";
import ligmaRouter from "./ligma.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(ligmaRouter);

export default router;
