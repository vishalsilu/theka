import express from "express"
import { addAddress,  deleteAddress,  getAddresses,  getMe,  loginUser, registerUser, updateAddress, updateUser, logoutUser } from "../controllers/userController.js"
import { protect } from "../middleware/authMiddleware.js";

const routes = express.Router()

routes.post('/register',registerUser);
routes.post('/login',loginUser)
routes.post('/logout', logoutUser);
routes.patch('/update-profile',protect,updateUser)
routes.get('/address/:id',protect,getAddresses)
routes.post('/add-address',protect,addAddress)
routes.patch('/update-address',protect,updateAddress)
routes.delete('/delete-address/:id/:addressId',protect,deleteAddress)
routes.get('/me', protect, getMe);

export default routes