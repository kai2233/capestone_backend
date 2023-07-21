// const express = require("express");
const router = require("express").Router();
const { User, Flights } = require("../db/models");
require('dotenv').config();
const axios = require('axios');
const Amadeus = require('amadeus');

const amadeus = new Amadeus({
    clientId: process.env.AMADUES_CLIENT_ID,
    clientSecret: process.env.AMADUES_CLIENT_SECRET
});

const DateJs = require('../util/datejs');
const { response } = require("express");

// url will be -> 'http://localhost:8080/api/flights?id=[user_id] '
router.get('/', async (req, res, next) => {
    try {
        const user_id = req.query.id;
        const reslut = await Flights.findAll({ where : {userId : user_id} })
        reslut ? 
            res.status(200).json(reslut) : res.status(404).json({message : 'get failed'});
    } catch (error) {
        console.error(error);
        next(error);
        res.status(404).json({message : 'get exception failed'})
    }
});


/*
    expecting query from request
                * means require, ? means optional
    { 
        * originLocationCode
        * destinationLocationCode : in ISO 8601 YYYY-MM-DD format
        * departureDate
        ? returnDate : if not specified, only one-way itineraries are found
        ? adults : more then 1, default value - 1
        ? nonStop : ture for no transfer, default value - false
        ? travelClass : ECONOMY, PREMIUM_ECONOMY, BUSINESS, FRIST, no value considers any class 
        ? currencyCode :  ISO 4217 format, @see https://en.wikipedia.org/wiki/ISO_4217
        ? max : maximum data be return, default value - 250
    }
example for this get request:
    url : 'http://localhost:8080/api/flights/search?originLocationCode=SYD&destinationLocationCode=BKK&departureDate=2023-08-02&adults=1'
*/
// search all the flights by given info
router.get('/search', async (req, res, next) => {
    try {
        const beginTime = new Date;
        const dataobj = {
            originLocationCode : req.query.originLocationCode,
            destinationLocationCode : req.query.destinationLocationCode,
            departureDate : req.query.departureDate,
            returnDate : req.query.returnDate, 
            adults : req.query.adults ? req.query.adults : 1,
            travelClass : req.query.travelClass,
            currencyCode : req.query.currencyCode ? req.query.currencyCode : 'USD',
            nonStop : req.query.nonStop ? req.query.nonStop : false,
            max : req.query.max >= 1 ? req.query.max : 250
        };
        const response = await amadeus.shopping.flightOffersSearch.get(dataobj).catch(err => {
            console.error(err);
            next(err);
        });
        var onewayFlag = dataobj.returnDate ? false : true;
        response ? 
            res.status(200).json(await flightsFilter(
                dataobj.originLocationCode, 
                dataobj.destinationLocationCode, 
                onewayFlag,
                response.data,
                response.result.dictionaries.locations)) :
            res.status(400).json({message : 'search failed'});
        const endTime = new Date;
        console.log('search time : ' + (beginTime.getTime() - endTime.getTime()));
    } catch (error) {   
        // console.error(error);
        next(error);
        res.status(400).json({message : 'search exception failed'});
    }
});

/*
{
return ->
    "type": "flight-offer",
    oneWay,
    origin_airport,
    arrival_airport,
    tickets: {
        departure_ticket : [
            {
                departure : {
                    iataCode, time, location {cityCode, countryCode}
                },
                arrival : {
                    iataCode, time, location {cityCode, countryCode}
                },
                flight : {
                    carrierCode, number
                }
                flight_number,
                duration,
                cabin,
                emissions
            }, ....
        ],
        return_ticket: [
            {
                departure : {
                    iataCode, time, location {cityCode, countryCode}
                },
                arrival : {
                    iataCode, time, location {cityCode, countryCode}
                },
                flight : {
                    carrierCode, number
                }
                flight_number,
                duration,
                cabin,
                emissions
            }
        ]
    },
    total_departure_duration,
    total_return_duration，
    total_price: {
        total,
        currency
    }
}
*/
async function flightsFilter(org, arri, oneway, flightdata, locations) {

    const filteredFlights = filterOriginFlights(flightdata, org, arri);
 
    const populateWithEmissions =  filteredFlights.map(async ticketData => {
        const segments = ticketData.itineraries[0].segments;
        const origin_airport = segments[0].departure.iataCode;
        const final_airport = segments[segments.length - 1].arrival.iataCode;

        const newdata = {};
        newdata.type = ticketData.type;
        newdata.oneWay = oneway;
        newdata.origin_airport = origin_airport;
        newdata.arrival_airport = final_airport;
        const departure_segments = segments;
        newdata.tickets = {};

        newdata.total_departure_duration = ticketData.itineraries[0].duration.substring(2);
        newdata.tickets.departure_ticket = segmentsFilter(departure_segments, locations);

        const segmentDetails = ticketData.travelerPricings[0].fareDetailsBySegment;

        for (var i = 0; i < segments.length; i++) { //set cabin for each departure_ticket
            newdata.tickets.departure_ticket[i].cabin = segmentDetails[i].cabin;
        }

        for (const ticket of newdata.tickets.departure_ticket) {
            await setEmission({
                    departure_location : ticket.departure.iataCode,
                    arrival_location : ticket.arrival.iataCode,
                    carrier_code : ticket.flight.carrierCode,
                    flight_number : ticket.flight.number,
                    cabin_class : ticket.cabin
                }, ticket.departure.time, ticket)
        }

        if (!oneway) {
            const return_segments = ticketData.itineraries[1].segments;
            newdata.total_return_duration = ticketData.itineraries[1].duration.substring(2);
            newdata.tickets.return_ticket = segmentsFilter(return_segments, locations);
            for (var i = newdata.tickets.departure_ticket.length; i < segmentDetails.length; i++) {
                newdata.tickets.return_ticket[i - newdata.tickets.departure_ticket.length].cabin = segmentDetails[i].cabin;
            }

            for (const ticket of newdata.tickets.return_ticket) {
                await setEmission({
                    departure_location : ticket.departure.iataCode,
                    arrival_location : ticket.arrival.iataCode,
                    carrier_code : ticket.flight.carrierCode,
                    flight_number : ticket.flight.number,
                    cabin_class : ticket.cabin
                }, ticket.departure.time, ticket);
            }
        }

        newdata.total_price = {
            total: ticketData.price.total,
            currency: ticketData.price.currency
        }
        return newdata;

    })
    return Promise.all(populateWithEmissions);
}

function filterOriginFlights(flightdata, org, arri) {
    const filteredFlights = flightdata.filter(ticketData => {
        const segments = ticketData.itineraries[0].segments;
        const origin_airport = segments[0].departure.iataCode;
        const final_airport = segments[segments.length - 1].arrival.iataCode;

        return (origin_airport == org || final_airport == arri)
    })
    return filteredFlights;
}

function segmentsFilter(segments, locations) {
    return segments.map(element => {
        return {
            departure: {
                iataCode: element.departure.iataCode,
                time: element.departure.at.replace('T', ' '),
                location : {
                    ... locations[element.departure.iataCode]
                } 
            },
            arrival: {
                iataCode: element.arrival.iataCode,
                time: element.arrival.at.replace('T', ' '),
                location : {
                    ... locations[element.arrival.iataCode]
                } 
            },
            flight: {
                carrierCode: element.carrierCode,
                number: element.number,
            },
            flight_number: element.carrierCode + ' ' + element.number,
            duration: element.duration.substring(2),
            cabin: undefined
        }
    });
}


/*
    expecting body from request
        {
            userId : 1
            carrier_code : 'CX',
            flight_number : 830,
            departure_date: '2023-08-01 12:10:00-04'
            arrival_date : '2023-08-01 14:45:00'
        }
*/
// delete flight info from database given by user, without checking if data exists
router.delete('/flight', async (req, res, next) => {
    try {
        const bodydata = req.body;
        await Flights.destroy({
            where : {
                userId : bodydata.userId,
                flight_number : bodydata.flight_number,
                carrier_code : bodydata.carrier_code,
                departure_date : bodydata.departure_date,
                arrival_date : bodydata.arrival_date
            }
        }).catch((error) => {
            console.error(error.response);
            res.status(400).send({message : 'delete failed'});
            next(error);
        });
        res.status(200).send({message : 'delete ok'});
    } catch (error) {
        console.error(error.response);
        next(error);
        res.status(400).send({message : 'delete exception failed'});
    }
});


/*
    expecting body from request
        {
            userEmail : 'user@example.com'
            carrierCode : 'CX',
            flightNumber: '840',
            scheduledDepartureDate: '2023-07-13'
            cabin_class : 'economy'
            emissions : 110
        }
*/
// insert flights info into database given by user, without checking duplicates
router.post('/newflight', async (req, res, next) => {
    const userEmail = req.body.userEmail;
    const flightData = {
        carrierCode : req.body.carrierCode,
        flightNumber : req.body.flightNumber, 
        scheduledDepartureDate : req.body.scheduledDepartureDate
    }
    console.log('flightData : ', flightData);

    var foundUser = await User.findAll({ where: { email: userEmail } });
    if (foundUser.length === 0) {
        res.status(404).json({message : 'User not found'});
        next(new Error('User not found'));
        return;
    }
    
    amadeus.schedule.flights.get(flightData).then(async function(response) {
        const resData = response.data[0];
        const flight_number = resData.flightDesignator.flightNumber;
        const carrier_code = resData.flightDesignator.carrierCode;
        const departure_location = resData.flightPoints[0].iataCode;
        const departure_date = resData.flightPoints[0].departure.timings[0].value;
        const arrival_location = resData.flightPoints[1].iataCode; 
        const arrival_date = resData.flightPoints[1].arrival.timings[0].value;

        flightobj = {
            carrier_code, flight_number, departure_date, departure_location, arrival_date, arrival_location, cabin_class : req.body.cabin_class ? req.body.cabin_class : 'economy', emissions : req.body.emissions ? req.body.emissions : -1
        }

        console.log('flightobj : ', flightobj);
        await setEmission(flightobj, flightobj.departure_date, flightobj);
        
        // insert into database
        await Flights.create({
            ...flightobj,
            userId :  foundUser[0].dataValues.id
        });  

        res.status(200).send(resData);
    }).catch(function(responseError){
        console.log(responseError);
        next(responseError);
        res.status(400).json({message : 'insert exception error'});
    });
});

async function setEmission (flight, departureDate, finalDate) {
    if (finalDate.emissions > 0) {
        return;
    }

    try {
        const dateJs = new DateJs(departureDate);
        const response = await axios.post(
            'https://travelimpactmodel.googleapis.com/v1/flights:computeFlightEmissions',
            {
                'flights': [
                    {
                        'origin' : flight.departure_location,
                        'destination' : flight.arrival_location,
                        'operating_carrier_code' : flight.carrier_code,
                        'flight_number' : flight.flight_number,
                        'departure_date' : {
                            'year' : dateJs.year(), 
                            'month' : dateJs.month(), 
                            'day' : dateJs.day()
                        }
                    },
                ]
            },
            {
              params: {
                'key': process.env.TRAVEK_IMPACT_MODEL
              },
              headers: {
                'Content-Type': 'application/json'
              }
            }
        ).catch(error => {
            console.error(error);
            throw error;
        });
        const responsedata = response.data.flightEmissions[0];
        if (!responsedata.emissionsGramsPerPax) {
            finalDate.emissions = -1;
        } else if (flight.cabin_class.toLowerCase() == 'economy') {
            finalDate.emissions = responsedata.emissionsGramsPerPax.economy;
        } else if (flight.cabin_class.toLowerCase() == 'premium_economy') {
            finalDate.emissions = responsedata.emissionsGramsPerPax.premiumEconomy;
        } else if (flight.cabin_class.toLowerCase() == 'business') {
            finalDate.emissions = responsedata.emissionsGramsPerPax.business;
        } else if (flight.cabin_class.toLowerCase() == 'first') {
            finalDate.emissions = responsedata.emissionsGramsPerPax.first;
        } else {
            finalDate.emissions = -1;
        }
    } catch (error) {
       throw error;
    }
    
    return response;
}

module.exports = router;