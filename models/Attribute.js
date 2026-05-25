import mongoose from 'mongoose';

const attributeSchema = new mongoose.Schema({
  key: { type: String, required: true, index: true },
  name: { type: String, required: true },
}, {
  timestamps: true
});

const Attribute = mongoose.model('Attribute', attributeSchema);
export default Attribute;
