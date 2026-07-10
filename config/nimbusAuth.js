// utils/nimbusAuth.js
import axios from "axios";
import dotenv from 'dotenv';
dotenv.config();

const getNimbusToken = () => {
  try {
    // Send the API Key and Secret Key to get a session token
    const response = await axios.post('https://api.nimbuspost.com/v1/users/generate_token', {
      api_key: process.env.NIMBUS_API_KEY,
      secret_key: process.env.NIMBUS_SECRET_KEY
    });
    
    // Return the generated Bearer token
    return response.data.data.token;
  } catch (error) {
    console.error("NimbusPost Key Authentication Failed:", error.response?.data || error.message);
    throw new Error('Failed to authenticate with API Keys');
  }
}


export default getNimbusToken