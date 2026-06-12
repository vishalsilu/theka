import express from "express"
import { 
    addAddress, 
    deleteAddress, 
    getAddresses, 
    getMe, 
    updateAddress, 
    updateUser, 
    logoutUser,
    requestEmailOTP,
    verifyEmailOTP,
    completeRegistration,
    checkAuthIdentity,
    getAllUsersAdmin,
    getUserAdmin,
    updateUserAdmin,
    deleteUserAdmin,
    handleContactUsRequest
} from "../controllers/userController.js"
import { protect } from "../middleware/authMiddleware.js";
import { adminOnly } from "../middleware/adminMiddleware.js";
import { otpLimiter } from "../middleware/otpLimiter.js";

const routes = express.Router()

routes.post('/email/check-identity', checkAuthIdentity);
routes.post('/email/send-otp', otpLimiter, requestEmailOTP);
routes.post('/email/verify-otp', verifyEmailOTP);
routes.post('/email/complete-registration', completeRegistration);

routes.post('/email/contact',  handleContactUsRequest);


routes.patch('/update-address', protect, updateAddress);

routes.post('/logout', logoutUser);



routes.patch('/update-profile', protect, updateUser);
routes.get('/me', protect, getMe);
routes.get('/all', protect, adminOnly, getAllUsersAdmin);
routes.get('/:id', protect, adminOnly, getUserAdmin);


routes.get('/address/:id', protect, getAddresses);
routes.post('/add-address', protect, addAddress);
routes.delete('/delete-address/:id/:addressId', protect, deleteAddress);
routes.patch('/:userId', protect, adminOnly, updateUserAdmin);
routes.delete('/:userId', protect, adminOnly, deleteUserAdmin);

export default routes;




// import express from "express"
// import { addAddress,  deleteAddress,  getAddresses,  getMe,  loginUser, registerUser, updateAddress, updateUser, logoutUser } from "../controllers/userController.js"
// import { protect } from "../middleware/authMiddleware.js";

// const routes = express.Router()

// routes.post('/register',registerUser);
// routes.post('/login',loginUser)
// routes.post('/logout', logoutUser);
// routes.patch('/update-profile',protect,updateUser)
// routes.get('/address/:id',protect,getAddresses)
// routes.post('/add-address',protect,addAddress)
// routes.patch('/update-address',protect,updateAddress)
// routes.delete('/delete-address/:id/:addressId',protect,deleteAddress)
// routes.get('/me', protect, getMe);

// export default routes