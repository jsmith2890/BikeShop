/* eslint-disable max-statements */
/* eslint-disable complexity */
const router = require('express').Router()
const {Cart,CartEntry,Bike,BikeImage,Order,OrderEntries} = require('../db/models')
module.exports = router

//POST /api/carts/:cartId/createorder
//convert cartid to order object and clear cart
//
//front end will have captured all necessary info to
//include with order like name/shipping/etc.
//
//front end will have also completed payment verification
//
//TODO: record credit card info with order for refunds
router.post('/:cartId/createorder', async (req, res, next) => {
  let cartId = +req.params.cartId
  if (cartId<=0) {
    const err = new Error('invalid cartid');
    next(err)
    return;
  }
  let cart;
  try {
    cart = await Cart.findById(cartId, {
      include: [{model: CartEntry}]
    });
  } catch (err) {
    next(err)
    return
  }

  if (cart.cartentries.length<=0) {
    const err = new Error('empty cart');
    next(err);
    return;
  }

  //need at least an email for the order
  if (! (req.body.shippingEmail)) {
    const err = new Error('need email for order')
    next(err)
    return
  }

  //TODO - wrap order creation in a transaction
  //TODO - create enum to correspond to order state in sequelize model

  const newOrder = {}
  newOrder.state='created'

  //link to user if available (otherwise must be a guest)
  if (req.user) {
    newOrder.userId = req.user.dataValues.id
  }

  newOrder.shippingEmail = req.body.shippingEmail

  if (req.body.shippingName) {
    newOrder.shippingName=req.body.shippingName
  }

  if (req.body.shippingAddress) {
    newOrder.shippingAddress=req.body.shippingAddress
  }

  if (req.body.shippingCity) {
    newOrder.shippingCity=req.body.shippingCity
  }

  if (req.body.shippingState) {
    newOrder.shippingState=req.body.shippingState
  }

  if (req.body.shippingZip) {
    newOrder.shippingZip=req.body.shippingZip
  }

  //create the order row in db now so we can at least
  //get the order id to link the orderEntries

  let order;
  try {
    order = await Order.create(newOrder)
  } catch (err) {
    next(err)
    return
  }

  //now create the entries, get total and then finally
  //update order afterwards
  let subtotal=0
  for (let cartEntry of cart.cartentries) {

    //get bike so we can get price
    let bike
    try {
      bike = await Bike.findById(cartEntry.bikeId)
    } catch (err) {
      next(err)
      return
    }

    const newOrderEntry={}
    newOrderEntry.orderId=order.id
    newOrderEntry.bikeId=bike.id;
    newOrderEntry.quantity=cartEntry.quantity;
    let orderPrice=Math.round(bike.price*100);
    newOrderEntry.price=orderPrice;
    subtotal=subtotal+(orderPrice*cartEntry.quantity);

    try {
      await OrderEntries.create(newOrderEntry)
      await cartEntry.destroy()
    } catch (err) {
      next(err)
      return
    }
  }

  //orderCost got implemented as integer, so go with it
  try {
    await order.update({orderCost:subtotal})
  } catch (err) {
    //TODO - expect transaction to handle rollback of
    //created order entries
    next(err)
    return
  }

  //now blow away the cart
  try {
    await cart.destroy()
  }
  catch (err) {
    next(err)
  }

  //now get the whole order and send back to front end
  try {
    order = await Order.findById(order.id,{include: [{all: true}]})
    res.json(order)
  } catch (err) {
    next(err)
  }

})


//POST /api/carts/:cartid/:bikeid
//cartid===0:create new cart?find existing cart
//if cart has entry for bikeid, increment it, else add new entry
//
//output: {id, subtotal, cartentries:[{bikeid,name,price,quantity,image}]}
router.post('/:cartId/:bikeId', async (req, res, next) => {

  let cart
  try {
    let newCart={}
    if (+req.params.cartId===0) {
      //get cookie or userid to link to cart
      cart = await Cart.create(newCart)
    } else {
      cart = await Cart.findById(+req.params.cartId);
      if (!cart) { //stale cart id from lso
        cart = await Cart.create(newCart)
      }
    }
  } catch (err) {
    next(err)
    return
  }

  //go find bike before attempting to work with cart entry
  let bike;
  try {
    bike = await Bike.findById(+req.params.bikeId);
  } catch (err) {
    next(err)
    return
  }

  //now have cart with id.  see if entry with bikeId exists
  let needNewEntry=false;
  let cartEntry={}
  try {
    const cartEntries = await CartEntry.findAll({
      where:
        {cartId:cart.id,
         bikeId:bike.id}
    })
    if (cartEntries.length===0) {
      needNewEntry=true;
    } else if (cartEntries.length>1) {
      throw new Error('more than one cartentries with same cartId/bikeId')
    }
    cartEntry=cartEntries[0] //just get the one cart entry out
  } catch (err) {
    next(err)
    return
  }

  if (bike.inventory<1) {
    let feCart
    try {
      feCart = await _generateFrontEndCart(cart.id,`no more stock available for: ${bike.name}\nplease contact customer service for further assistance with this product\n`)
    } catch (err) {
      next (err)
      return
    }
    res.json(feCart)
    return
  }

  //TODO: use sequelize transaction to decrement inventory and create/update cart entry
  //decrement inventory
  bike.inventory = bike.inventory-1;
  try {
    await Bike.update(
      {inventory: bike.inventory},
      {where: { id: bike.id }}
    );
  } catch (err) {
    next(err)
    return
  }

  //create cart entry if needed with quantity 1
  if (needNewEntry) {
    const newCartEntry={}
    newCartEntry.bikeId=bike.id;
    newCartEntry.cartId=cart.id;
    newCartEntry.quantity=1

    try {
      cartEntry =await  CartEntry.create(newCartEntry);
    } catch (err) {
      next(err)
      return
    }
  //update quantity in cart
  } else {
    try {
      cartEntry.quantity=cartEntry.quantity+1
      await CartEntry.update(
        {quantity:cartEntry.quantity},
        { where: { cartId: cart.id, bikeId: bike.id } }
      )
    } catch (err) {
    next(err)
    return
    }
  }

  //generate simple cart for front end use
  let feCart
  try {
    feCart = await _generateFrontEndCart(cart.id)
  } catch (err) {
    next (err)
    return
  }

  res.json(feCart)
})

//DELETE /api/carts/:cartid/:bikeid/all
//delete cart entry for this bikeid
//THIS ROUTE IS ADDED BEFORE THE DELETE FOR
//A SINGLE DECREMENT
//
//output: {id, subtotal, cartentries:[{bikeid,name,price,quantity,image}]}
router.delete('/:cartId/:bikeId/all', async (req, res, next) => {
  //cart must exist, go get it
  let cart
  try {
    cart = await Cart.findById(+req.params.cartId);
  } catch (err) {
    next(err)
    return
  }

  //go find bike before attempting to work with cart entry
  let bike;
  try {
    bike = await Bike.findById(+req.params.bikeId);
  } catch (err) {
    next(err)
    return
  }

  //now have cart with id.  see if entry with bikeId exists
  let cartEntry={}
  try {
    const cartEntries = await CartEntry.findAll({
      where:
        {cartId:cart.id,
         bikeId:bike.id}
    })
    if (cartEntries.length===0) {
      throw new Error('cart entry not found')
    } else if (cartEntries.length>1) {
      throw new Error('more than one cartentries with same cartId/bikeId')
    }
    cartEntry=cartEntries[0] //just get the one cart entry out
  } catch (err) {
    next(err)
    return
  }

  //TODO: use sequelize transaction to increment inventory and update/delete cart entry
  //decrement inventory
  bike.inventory = bike.inventory+cartEntry.quantity;
  try {
    await Bike.update(
      {inventory: bike.inventory},
      {where: { id: bike.id }}
    );
  } catch (err) {
    next(err)
    return
  }

  try {
    await CartEntry.destroy({ where: {cartId: cart.id, bikeId:bike.id}})
  } catch (err) {
    next(err)
    return
  }

  //generate simple cart for front end use
  let feCart
  try {
    feCart = await _generateFrontEndCart(cart.id)
  } catch (err) {
    next (err)
    return
  }

  console.log(feCart)
  res.json(feCart)

})

//DELETE /api/carts/:cartid/:bikeid
//if cart has entry for bikeid, decrement it
//if cart quantity goes to 0, delete the cart entry
//
//output: {id, subtotal, cartentries:[{bikeid,name,price,quantity,image}]}
router.delete('/:cartId/:bikeId', async (req, res, next) => {
  //cart must exist, go get it
  let cart
  try {
    cart = await Cart.findById(+req.params.cartId);
  } catch (err) {
    next(err)
    return
  }

  //go find bike before attempting to work with cart entry
  let bike;
  try {
    bike = await Bike.findById(+req.params.bikeId);
  } catch (err) {
    next(err)
    return
  }

  //now have cart with id.  see if entry with bikeId exists
  let cartEntry={}
  try {
    const cartEntries = await CartEntry.findAll({
      where:
        {cartId:cart.id,
         bikeId:bike.id}
    })
    if (cartEntries.length===0) {
      throw new Error('cart entry not found')
    } else if (cartEntries.length>1) {
      throw new Error('more than one cartentries with same cartId/bikeId')
    }
    cartEntry=cartEntries[0] //just get the one cart entry out
  } catch (err) {
    next(err)
    return
  }

  //TODO: use sequelize transaction to increment inventory and update/delete cart entry
  //decrement inventory
  bike.inventory = bike.inventory+1;
  try {
    await Bike.update(
      {inventory: bike.inventory},
      {where: { id: bike.id }}
    );
  } catch (err) {
    next(err)
    return
  }

  try {
    cartEntry.quantity=cartEntry.quantity-1

    //either delete the cart entry or update it
    if (cartEntry.quantity===0) {
      await CartEntry.destroy({ where: {cartId: cart.id, bikeId:bike.id}})
    } else {
      await CartEntry.update(
        {quantity:cartEntry.quantity},
        { where: { cartId: cart.id, bikeId: bike.id } }
    )}
  } catch (err) {
    next(err)
    return
  }

  //generate simple cart for front end use
  let feCart
  try {
    feCart = await _generateFrontEndCart(cart.id)
  } catch (err) {
    next (err)
    return
  }

  console.log(feCart)
  res.json(feCart)

})

//POST /api/carts/ -- for now assume nothing there and start writing it,
//will have to clean up later
router.post('/', async (req, res, next) => {
  try {
    //create basic cart entry, sequelize will ignore entries
    const cart= await Cart.create(req.body);

    //now go through entries and put those in db
    for (const entry of req.body.cartentries) {
      entry.cartId=cart.id;
      console.log(entry);
      const newEntry=await CartEntry.create(entry);
      console.log(newEntry);
    }
    const newCart = await Cart.findById(cart.id,
      {include: [{model: CartEntry}]})
    res.json(newCart)
  } catch (err) {
    next(err)
  }
})

//GET /api/carts/:cartId - get a single cart by id joined with its entries
router.get('/:cartId', async (req,res,next) => {
  try {
    const cart = await _generateFrontEndCart(req.params.cartId)
    res.json(cart)
  } catch (err) {
    next(err)
  }
})

//UTILITY FUNCTIONS
//

//GENERATE CART FOR FRONT END USE
//INPUT - cart id
//OUTPUT - object than can be passed up to front end as json
//CALLER needs to do try/catch on this for db err
async function _generateFrontEndCart(cartId,msg)  {

  const feCart={}
  let subtotal=0; //cart will get this filled in later
  feCart.quantity=0; //total number of items in cart
  feCart.cartId = cartId;
  feCart.cartEntries=[]
  if (msg) {
    feCart.msg=msg
  }

  //if a new cart was needed by caller and had
  //problems getting bike, just return empty cart
  if (cartId===0) {
    return feCart;
  }

  let cart;
  try {
    cart = await Cart.findById(cartId,
      {include: [{model:CartEntry}],
      order: [
        [ CartEntry, 'bikeId' ]
        ]
      }
    );
  } catch (err) {
    feCart.cartId = 0
    console.log('err getting cart')
    return feCart;
  }

  //stale lso
  if (!cart) {
    feCart.cartId = 0
    console.log('null cart on dip - returning cartId=0')
    return feCart;
  }

  for (let cartEntry of cart.cartentries) {
    let bike
    bike = await Bike.findById(cartEntry.bikeId,
      { include: [{model:BikeImage}]})

    const feCartEntry={}
    feCartEntry.bikeId=bike.id;
    feCartEntry.name=bike.name;
    feCartEntry.quantity=cartEntry.quantity;
    feCart.quantity=feCart.quantity+cartEntry.quantity;
    feCartEntry.price=bike.price;
    subtotal=subtotal+((Math.round(bike.price*100)*cartEntry.quantity));

    if (bike.bikeimages && bike.bikeimages.length>0) {
      feCartEntry.image = bike.bikeimages[0].imageUrl
    }

    feCart.cartEntries.push(feCartEntry)
  }

  if (subtotal>0) {
    const subtotalStr = String(subtotal)
    feCart.subtotal = subtotalStr.slice(0,-2)+'.'+subtotalStr.slice(-2)
  } else {
    feCart.subtotal = '0.00'
  }

  return feCart;
}
